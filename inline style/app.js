// app.js — Monitor CPU & Disk
// Konek ke backend FastAPI via WebSocket (lewat ZeroTier)

const MAX = 40;
let paused = false;
let ws     = null;
let reconnectTimer = null;

let cpuHist   = Array(MAX).fill(null);
let tempHist  = Array(MAX).fill(null);
let readHist  = Array(MAX).fill(null);
let writeHist = Array(MAX).fill(null);

// ── Charts ────────────────────────────────────────────────
const cpuChart = new Chart(document.getElementById('cpuChart'), {
  type: 'line',
  data: {
    labels: Array(MAX).fill(''),
    datasets: [
      {
        label: 'CPU %',
        data: [...cpuHist],
        borderColor: '#185FA5',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
        yAxisID: 'y'
      },
      {
        label: 'Suhu',
        data: [...tempHist],
        borderColor: '#7F77DD',
        borderDash: [4, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false,
        yAxisID: 'y2'
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: { legend: { display: false } },
    scales: {
      y: {
        min: 0, max: 100,
        ticks: { font: { size: 10 }, color: '#888', callback: v => v + '%' },
        grid:  { color: 'rgba(136,135,128,0.12)' }
      },
      y2: {
        position: 'right',
        min: 30, max: 105,
        ticks: { font: { size: 10 }, color: '#7F77DD', callback: v => v + '°' },
        grid:  { drawOnChartArea: false }
      },
      x: { display: false }
    }
  }
});

const diskChart = new Chart(document.getElementById('diskChart'), {
  type: 'line',
  data: {
    labels: Array(MAX).fill(''),
    datasets: [
      {
        label: 'Read',
        data: [...readHist],
        borderColor: '#1D9E75',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.4,
        fill: false
      },
      {
        label: 'Write',
        data: [...writeHist],
        borderColor: '#D85A30',
        borderDash: [4, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: { legend: { display: false } },
    scales: {
      y: {
        min: 0,
        ticks: { font: { size: 10 }, color: '#888', callback: v => v + ' MB/s' },
        grid:  { color: 'rgba(136,135,128,0.12)' }
      },
      x: { display: false }
    }
  }
});

// ── Helpers ───────────────────────────────────────────────
function dotClass(val, warn, danger) {
  if (val >= danger) return 'dot-danger';
  if (val >= warn)   return 'dot-warn';
  return 'dot-ok';
}

function renderCores(cores) {
  const el = document.getElementById('cores');
  if (el.children.length !== cores.length) {
    el.innerHTML = cores.map((_, i) => `
      <div class="core-row">
        <span class="core-lbl">Core ${i}</span>
        <div class="core-track">
          <div class="core-fill" id="cf${i}"></div>
        </div>
        <span class="core-val" id="cv${i}">0%</span>
      </div>`).join('');
  }
  cores.forEach((v, i) => {
    const fill  = document.getElementById('cf' + i);
    const label = document.getElementById('cv' + i);
    if (fill) {
      fill.style.width      = v + '%';
      fill.style.background = v >= 80 ? '#A32D2D' : v >= 60 ? '#BA7517' : '#185FA5';
    }
    if (label) label.textContent = v + '%';
  });
}

// ── Apply metrics from WebSocket ──────────────────────────
function applyMetrics(d) {
  if (paused) return;

  // CPU
  const cpu = d.cpu;
  document.getElementById('cpu-total').textContent = cpu.total;
  document.getElementById('cpu-sub').textContent   = cpu.temp != null ? 'Suhu: ' + cpu.temp + '°C' : 'Suhu: —';
  document.getElementById('cpu-dot').className     = 'status-dot ' + dotClass(cpu.total, 60, 85);
  renderCores(cpu.cores);

  cpuHist.push(cpu.total);        if (cpuHist.length  > MAX) cpuHist.shift();
  tempHist.push(cpu.temp ?? null); if (tempHist.length > MAX) tempHist.shift();
  cpuChart.data.datasets[0].data = [...cpuHist];
  cpuChart.data.datasets[1].data = [...tempHist];
  cpuChart.update('none');

  // Disk
  const disk    = d.disk;
  const totalIO = Math.round((disk.read_mbs + disk.write_mbs) * 10) / 10;

  document.getElementById('disk-io').textContent          = totalIO;
  document.getElementById('disk-write').textContent       = disk.write_mbs.toFixed(1) + ' MB/s';
  document.getElementById('disk-read').textContent        = disk.read_mbs.toFixed(1)  + ' MB/s';
  document.getElementById('disk-lat').textContent         = Math.round(2 + (totalIO / 200) * 18) + ' ms';
  document.getElementById('disk-cap').textContent         = disk.total_gb + ' GB';
  document.getElementById('disk-bar').style.width         = disk.percent + '%';
  document.getElementById('disk-used-lbl').textContent    = disk.used_gb + ' GB terpakai';
  document.getElementById('disk-free-lbl').textContent    = disk.free_gb + ' GB bebas';
  document.getElementById('disk-storage-label').textContent =
    'Pemakaian disk (' + disk.total_gb + ' GB) — ' + disk.percent + '%';
  document.getElementById('disk-dot').className =
    'status-dot ' + dotClass(disk.percent, 75, 90);

  readHist.push(disk.read_mbs);   if (readHist.length  > MAX) readHist.shift();
  writeHist.push(disk.write_mbs); if (writeHist.length > MAX) writeHist.shift();
  diskChart.data.datasets[0].data = [...readHist];
  diskChart.data.datasets[1].data = [...writeHist];
  diskChart.update('none');
}

// ── WebSocket ─────────────────────────────────────────────
function setStatus(ok, msg) {
  const dot = document.getElementById('ws-dot');
  dot.className = ok ? 'ws-ok' : 'ws-err';
  document.getElementById('ws-label').textContent = msg;
}

function connect(url) {
  if (ws) { ws.onclose = null; ws.close(); }
  setStatus(false, 'Menghubungkan ke ' + url + ' ...');
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus(true, 'Terhubung — ' + url);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    try { applyMetrics(JSON.parse(e.data)); } catch (_) {}
  };

  ws.onerror = () => setStatus(false, 'Gagal konek');

  ws.onclose = () => {
    setStatus(false, 'Koneksi putus — coba lagi dalam 5 detik...');
    reconnectTimer = setTimeout(
      () => connect(document.getElementById('ws-url').value.trim()),
      5000
    );
  };
}

function reconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connect(document.getElementById('ws-url').value.trim());
}

function togglePause(btn) {
  paused = !paused;
  btn.innerHTML = paused
    ? '<i class="ti ti-player-play" aria-hidden="true"></i> Paused'
    : '<i class="ti ti-player-pause" aria-hidden="true"></i> Live';
  btn.classList.toggle('active', !paused);
}

// Auto-konek saat load (skip jika URL masih placeholder)
window.addEventListener('load', () => {
  const url = document.getElementById('ws-url').value.trim();
  if (!url.includes('x.x.x')) connect(url);
});