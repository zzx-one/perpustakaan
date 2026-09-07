# server.py
# Install dulu: pip install fastapi uvicorn websockets psutil

import asyncio
import json
import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Izinkan semua origin (frontend bisa dari IP ZeroTier manapun)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_metrics():
    cpu_total = psutil.cpu_percent(interval=None)
    cpu_cores = psutil.cpu_percent(interval=None, percpu=True)
    temp = None
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for key in ("coretemp", "cpu_thermal", "k10temp", "acpitz"):
                if key in temps and temps[key]:
                    temp = round(temps[key][0].current, 1)
                    break
    except Exception:
        pass

    disk = psutil.disk_usage("/")
    disk_io = psutil.disk_io_counters()

    return {
        "cpu": {
            "total": round(cpu_total, 1),
            "cores": [round(c, 1) for c in cpu_cores],
            "temp": temp,
        },
        "disk": {
            "total_gb": round(disk.total / 1e9, 1),
            "used_gb": round(disk.used / 1e9, 1),
            "free_gb": round(disk.free / 1e9, 1),
            "percent": round(disk.percent, 1),
            "read_bytes": disk_io.read_bytes if disk_io else 0,
            "write_bytes": disk_io.write_bytes if disk_io else 0,
        },
    }

# Simpan snapshot I/O sebelumnya untuk hitung delta MB/s
_prev_io = {"read": 0, "write": 0, "ts": asyncio.get_event_loop().time() if False else 0}

@app.websocket("/ws/metrics")
async def metrics_ws(websocket: WebSocket):
    await websocket.accept()
    prev_read = prev_write = 0
    prev_ts = asyncio.get_event_loop().time()

    # Inisialisasi cpu_percent supaya bacaan pertama akurat
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(interval=None, percpu=True)

    try:
        while True:
            await asyncio.sleep(1)
            metrics = get_metrics()

            # Hitung MB/s dari delta byte
            now_ts = asyncio.get_event_loop().time()
            elapsed = max(now_ts - prev_ts, 0.001)
            cur_read  = metrics["disk"]["read_bytes"]
            cur_write = metrics["disk"]["write_bytes"]
            read_mbs  = round((cur_read  - prev_read)  / elapsed / 1e6, 2)
            write_mbs = round((cur_write - prev_write) / elapsed / 1e6, 2)
            prev_read, prev_write, prev_ts = cur_read, cur_write, now_ts

            metrics["disk"]["read_mbs"]  = max(read_mbs,  0)
            metrics["disk"]["write_mbs"] = max(write_mbs, 0)
            del metrics["disk"]["read_bytes"]
            del metrics["disk"]["write_bytes"]

            await websocket.send_text(json.dumps(metrics))
    except WebSocketDisconnect:
        pass

# Jalankan:
# uvicorn server:app --host 0.0.0.0 --port 8000
# Ganti 0.0.0.0 dengan IP ZeroTier lo jika mau lebih aman:
# uvicorn server:app --host 10.x.x.x --port 8000