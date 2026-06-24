'use strict';

// ─── TX State ─────────────────────────────────────────────────────────────────
let mode     = 'fixed';
let protocol = 'tcp';
let sending  = false;
let pollTimer = null;

// ─── RX State ─────────────────────────────────────────────────────────────────
let rxProto     = 'all';
let rxLastId    = 0;
let rxPollTimer = null;
let rxReceiving = false;

// ─── Listener State ───────────────────────────────────────────────────────────
let listenerProto     = 'tcp';
let listenerPollTimer = null;
let listenerRunning   = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  // TX packet config
  srcMac:           $('srcMac'),
  dstMac:           $('dstMac'),
  arpTarget:        $('arpTarget'),
  btnArpResolve:    $('btnArpResolve'),
  vlanEnable:       $('vlanEnable'),
  vlanFields:       $('vlanFields'),
  vlanId:           $('vlanId'),
  vlanPcp:          $('vlanPcp'),
  srcIp:            $('srcIp'),
  dstIp:            $('dstIp'),
  dscpValue:        $('dscpValue'),
  dscpSelect:       $('dscpSelect'),
  portFields:       $('portFields'),
  srcPort:          $('srcPort'),
  dstPort:          $('dstPort'),
  iface:            $('iface'),
  pktCount:         $('pktCount'),
  pktRate:          $('pktRate'),
  pktSize:          $('pktSize'),
  pktSizePreset:    $('pktSizePreset'),
  fixedFields:      $('fixedFields'),
  continuousFields: $('continuousFields'),
  payload:          $('payload'),
  // TX actions
  btnSend:          $('btnSend'),
  btnStart:         $('btnStart'),
  btnStop:          $('btnStop'),
  // TX status
  statusBadge:      $('statusBadge'),
  statusText:       $('statusText'),
  liveCounter:      $('liveCounter'),
  liveCount:        $('liveCount'),
  // Interface config
  ifaceConfigIface: $('ifaceConfigIface'),
  ifaceIp:          $('ifaceIp'),
  ifacePill:        $('ifacePill'),
  btnIfaceUp:       $('btnIfaceUp'),
  btnIfaceDown:     $('btnIfaceDown'),
  // Routes
  routeDst:         $('routeDst'),
  routeNh:          $('routeNh'),
  routeIface:       $('routeIface'),
  btnRouteAdd:      $('btnRouteAdd'),
  routeList:        $('routeList'),
  btnRouteClear:    $('btnRouteClear'),
  // Log
  logOutput:        $('logOutput'),
  btnClear:         $('btnClear'),
  // RX routes
  rxRouteDst:         $('rxRouteDst'),
  rxRouteNh:          $('rxRouteNh'),
  rxRouteIface:       $('rxRouteIface'),
  btnRxRouteAdd:      $('btnRxRouteAdd'),
  rxRouteList:        $('rxRouteList'),
  btnRxRouteClear:    $('btnRxRouteClear'),
  // RX interface config
  rxIfaceSelect:      $('rxIfaceSelect'),
  rxIfaceIp:          $('rxIfaceIp'),
  rxIfacePill:        $('rxIfacePill'),
  btnRxIfaceUp:       $('btnRxIfaceUp'),
  btnRxIfaceDown:     $('btnRxIfaceDown'),
  // Socket listener
  listenerPort:       $('listenerPort'),
  listenerBindIp:     $('listenerBindIp'),
  btnListenerStart:   $('btnListenerStart'),
  btnListenerStop:    $('btnListenerStop'),
  listenerStats:      $('listenerStats'),
  listenerCount:      $('listenerCount'),
  listenerCountLabel: $('listenerCountLabel'),
  // Passive capture
  rxIface:            $('rxIface'),
  rxPort:             $('rxPort'),
  btnRxStart:         $('btnRxStart'),
  btnRxStop:          $('btnRxStop'),
  rxLiveCounter:      $('rxLiveCounter'),
  rxLiveCount:        $('rxLiveCount'),
  // RX header badge
  rxStatusBadge:      $('rxStatusBadge'),
  rxStatusText:       $('rxStatusText'),
  // Capture table
  captureWrap:        $('captureWrap'),
  captureBody:        $('captureBody'),
  btnRxClear:         $('btnRxClear'),
  btnDownloadPcap:    $('btnDownloadPcap'),
};

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg, type = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (type ? ` log-${type}` : '');
  line.textContent = msg;
  els.logOutput.appendChild(line);
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function logTs(msg, type) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  log(`[${t}] ${msg}`, type);
}

// ─── Status Badges ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  els.statusBadge.className = `status-badge ${state}`;
  els.statusText.textContent = text;
}

function setRxStatus(state, text) {
  els.rxStatusBadge.className = `status-badge ${state}`;
  els.rxStatusText.textContent = text;
}

// ─── Tab Bar ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.mode-tab').forEach(b =>
      b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p =>
      p.classList.toggle('hidden', p.id !== `panel-${tab}`));
  });
});

// ─── Segmented controls ───────────────────────────────────────────────────────
function wireSegGroup(groupId, onChange) {
  const group = $(groupId);
  group.querySelectorAll('.seg').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.seg').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.value);
    });
  });
}

// ─── Protocol toggle ──────────────────────────────────────────────────────────
wireSegGroup('protoGroup', val => {
  protocol = val;
  els.portFields.style.display = val !== 'icmp' ? '' : 'none';
});

// ─── TX Mode toggle ───────────────────────────────────────────────────────────
wireSegGroup('modeGroup', val => {
  mode = val;
  const fixed = val === 'fixed';
  els.fixedFields.style.display = fixed ? '' : 'none';
  els.continuousFields.classList.toggle('collapsed', fixed);
  els.btnSend.classList.toggle('hidden', !fixed);
  els.btnStart.classList.toggle('hidden', fixed);
  els.btnStop.classList.add('hidden');
});

// ─── RX Protocol toggle ───────────────────────────────────────────────────────
wireSegGroup('rxProtoGroup', val => { rxProto = val; });

// ─── Listener Protocol toggle ─────────────────────────────────────────────────
wireSegGroup('listenerProtoGroup', val => {
  listenerProto = val;
  els.listenerCountLabel.textContent = val === 'tcp' ? 'connections' : 'datagrams';
});

// ─── VLAN toggle ──────────────────────────────────────────────────────────────
els.vlanEnable.addEventListener('change', () => {
  els.vlanFields.classList.toggle('collapsed', !els.vlanEnable.checked);
});

// ─── DSCP quick-select ────────────────────────────────────────────────────────
els.dscpSelect.addEventListener('change', () => {
  if (els.dscpSelect.value !== '') {
    els.dscpValue.value = els.dscpSelect.value;
    els.dscpSelect.value = '';
  }
});

// ─── Frame size preset ────────────────────────────────────────────────────────
els.pktSizePreset.addEventListener('change', () => {
  if (els.pktSizePreset.value !== '') {
    els.pktSize.value = els.pktSizePreset.value;
    els.pktSizePreset.value = '';
  }
});

// ─── TX interface change → update src MAC ─────────────────────────────────────
els.iface.addEventListener('change', () => {
  const mac = _ifaceHwaddrs[els.iface.value];
  if (mac) els.srcMac.value = mac;
});

// ─── Config interface change → pre-fill existing IP ───────────────────────────
els.ifaceConfigIface.addEventListener('change', () => {
  const existing = _ifaceAddrs[els.ifaceConfigIface.value];
  if (existing) {
    els.ifaceIp.value = existing;
    els.ifacePill.textContent = existing;
    els.ifacePill.classList.remove('hidden');
  } else {
    els.ifacePill.classList.add('hidden');
  }
});

// ─── ARP Resolve ──────────────────────────────────────────────────────────────
els.btnArpResolve.addEventListener('click', async () => {
  const ip = els.arpTarget.value.trim();
  if (!ip) { logTs('Enter a next-hop IP to ARP resolve.', 'warn'); return; }
  els.btnArpResolve.disabled = true;
  els.btnArpResolve.textContent = '...';
  try {
    const res = await fetch('/api/arp/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, interface: els.iface.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'ARP failed');
    els.dstMac.value = data.mac;
    logTs(`Resolved ${ip} → ${data.mac} on ${data.interface}`, 'success');
  } catch (err) {
    logTs(`ARP resolve: ${err.message}`, 'error');
  } finally {
    els.btnArpResolve.disabled = false;
    els.btnArpResolve.textContent = 'ARP';
  }
});

// ─── Interface Config ─────────────────────────────────────────────────────────
els.btnIfaceUp.addEventListener('click', async () => {
  const body = { interface: els.ifaceConfigIface.value, ip: els.ifaceIp.value.trim() };
  els.btnIfaceUp.disabled = true;
  try {
    const res  = await fetch('/api/interface/up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Configure failed');
    els.ifacePill.textContent = body.ip;
    els.ifacePill.classList.remove('hidden');
    logTs(`Interface ${data.interface} configured — ${data.ip}`, 'success');
  } catch (err) {
    logTs(`Interface configure error: ${err.message}`, 'error');
  } finally {
    els.btnIfaceUp.disabled = false;
  }
});

els.btnIfaceDown.addEventListener('click', async () => {
  const iface = els.ifaceConfigIface.value;
  els.btnIfaceDown.disabled = true;
  try {
    const res  = await fetch('/api/interface/down', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Reset failed');
    els.ifacePill.classList.add('hidden');
    els.routeList.innerHTML = '';
    els.btnRouteClear.classList.add('hidden');
    logTs(`Interface ${data.interface} reset — address and routes flushed`, 'warn');
  } catch (err) {
    logTs(`Interface reset error: ${err.message}`, 'error');
  } finally {
    els.btnIfaceDown.disabled = false;
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
function addRouteItem(prefix, nexthop, iface) {
  const item = document.createElement('div');
  item.className = 'route-item';
  item.dataset.prefix  = prefix;
  item.dataset.nexthop = nexthop;
  item.dataset.iface   = iface;
  item.innerHTML =
    `<span class="route-item-text">${prefix}</span>` +
    `<span class="route-item-via">via</span>` +
    `<span class="route-item-text">${nexthop}</span>` +
    `<span class="route-item-via">dev</span>` +
    `<span class="route-item-dev">${iface}</span>` +
    `<button class="btn-icon" title="Remove">✕</button>`;
  item.querySelector('.btn-icon').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/routes/del', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, nexthop, interface: iface }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Delete failed');
      item.remove();
      if (!els.routeList.children.length) els.btnRouteClear.classList.add('hidden');
      logTs(`Route removed: ${prefix} via ${nexthop} dev ${iface}`, 'warn');
    } catch (err) {
      logTs(`Route remove error: ${err.message}`, 'error');
    }
  });
  els.routeList.appendChild(item);
  els.btnRouteClear.classList.remove('hidden');
}

els.btnRouteAdd.addEventListener('click', async () => {
  const prefix  = els.routeDst.value.trim();
  const nexthop = els.routeNh.value.trim();
  const iface   = els.routeIface.value;
  if (!prefix || !nexthop) { logTs('Destination and Next Hop are required.', 'warn'); return; }
  els.btnRouteAdd.disabled = true;
  try {
    const res = await fetch('/api/routes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, nexthop, interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Add failed');
    addRouteItem(prefix, nexthop, iface);
    els.routeDst.value = '';
    els.routeNh.value  = '';
    logTs(`Route added: ${prefix} via ${nexthop} dev ${iface}`, 'success');
  } catch (err) {
    logTs(`Route add error: ${err.message}`, 'error');
  } finally {
    els.btnRouteAdd.disabled = false;
  }
});

els.btnRouteClear.addEventListener('click', async () => {
  const iface = els.routeIface.value;
  try {
    const res = await fetch('/api/routes/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Flush failed');
    els.routeList.innerHTML = '';
    els.btnRouteClear.classList.add('hidden');
    logTs(`All routes flushed on ${data.interface}`, 'warn');
  } catch (err) {
    logTs(`Route flush error: ${err.message}`, 'error');
  }
});

// ─── RX Routes ────────────────────────────────────────────────────────────────
function addRxRouteItem(prefix, nexthop, iface) {
  const item = document.createElement('div');
  item.className = 'route-item';
  item.dataset.prefix  = prefix;
  item.dataset.nexthop = nexthop;
  item.dataset.iface   = iface;
  item.innerHTML =
    `<span class="route-item-text">${prefix}</span>` +
    `<span class="route-item-via">via</span>` +
    `<span class="route-item-text">${nexthop}</span>` +
    `<span class="route-item-via">dev</span>` +
    `<span class="route-item-dev">${iface}</span>` +
    `<button class="btn-icon" title="Remove">✕</button>`;
  item.querySelector('.btn-icon').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/routes/del', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, nexthop, interface: iface }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Delete failed');
      item.remove();
      if (!els.rxRouteList.children.length) els.btnRxRouteClear.classList.add('hidden');
      logTs(`Route removed: ${prefix} via ${nexthop} dev ${iface}`, 'warn');
    } catch (err) {
      logTs(`Route remove error: ${err.message}`, 'error');
    }
  });
  els.rxRouteList.appendChild(item);
  els.btnRxRouteClear.classList.remove('hidden');
}

els.btnRxRouteAdd.addEventListener('click', async () => {
  const prefix  = els.rxRouteDst.value.trim();
  const nexthop = els.rxRouteNh.value.trim();
  const iface   = els.rxRouteIface.value;
  if (!prefix || !nexthop) { logTs('Destination and Next Hop are required.', 'warn'); return; }
  els.btnRxRouteAdd.disabled = true;
  try {
    const res = await fetch('/api/routes/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, nexthop, interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Add failed');
    addRxRouteItem(prefix, nexthop, iface);
    els.rxRouteDst.value = '';
    els.rxRouteNh.value  = '';
    logTs(`Route added: ${prefix} via ${nexthop} dev ${iface}`, 'success');
  } catch (err) {
    logTs(`Route add error: ${err.message}`, 'error');
  } finally {
    els.btnRxRouteAdd.disabled = false;
  }
});

els.btnRxRouteClear.addEventListener('click', async () => {
  const iface = els.rxRouteIface.value;
  try {
    const res = await fetch('/api/routes/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Flush failed');
    els.rxRouteList.innerHTML = '';
    els.btnRxRouteClear.classList.add('hidden');
    logTs(`All routes flushed on ${data.interface}`, 'warn');
  } catch (err) {
    logTs(`Route flush error: ${err.message}`, 'error');
  }
});

// ─── RX Interface Config ──────────────────────────────────────────────────────
els.btnRxIfaceUp.addEventListener('click', async () => {
  const body = { interface: els.rxIfaceSelect.value, ip: els.rxIfaceIp.value.trim() };
  els.btnRxIfaceUp.disabled = true;
  try {
    const res  = await fetch('/api/interface/up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Configure failed');
    els.rxIfacePill.textContent = body.ip;
    els.rxIfacePill.classList.remove('hidden');
    // Auto-fill the listener bind IP with just the host part
    els.listenerBindIp.value = body.ip.split('/')[0].trim();
    logTs(`RX interface ${data.interface} configured — ${data.ip}`, 'success');
  } catch (err) {
    logTs(`RX interface configure error: ${err.message}`, 'error');
  } finally {
    els.btnRxIfaceUp.disabled = false;
  }
});

els.btnRxIfaceDown.addEventListener('click', async () => {
  const iface = els.rxIfaceSelect.value;
  els.btnRxIfaceDown.disabled = true;
  try {
    const res  = await fetch('/api/interface/down', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interface: iface }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Reset failed');
    els.rxIfacePill.classList.add('hidden');
    els.listenerBindIp.value = '0.0.0.0';
    logTs(`RX interface ${data.interface} reset — address and routes flushed`, 'warn');
  } catch (err) {
    logTs(`RX interface reset error: ${err.message}`, 'error');
  } finally {
    els.btnRxIfaceDown.disabled = false;
  }
});

// ─── Load interfaces ──────────────────────────────────────────────────────────
let _ifaceHwaddrs = {};
let _ifaceAddrs   = {};

async function loadInterfaces() {
  try {
    const res = await fetch('/api/interfaces');
    if (!res.ok) return;
    const { interfaces, hwaddrs, addrs, mgmt } = await res.json();
    _ifaceHwaddrs = hwaddrs || {};
    _ifaceAddrs   = addrs   || {};

    const preferred = interfaces.includes('eth1')
      ? 'eth1'
      : interfaces.find(i => i !== mgmt) || interfaces[0] || 'eth1';

    [els.iface, els.ifaceConfigIface, els.routeIface, els.rxIface, els.rxIfaceSelect, els.rxRouteIface].forEach(sel => {
      sel.innerHTML = '';
      interfaces.forEach(iface => {
        const opt = document.createElement('option');
        opt.value = iface;
        opt.textContent = iface;
        if (iface === preferred) opt.selected = true;
        sel.appendChild(opt);
      });
      if ([...sel.options].some(o => o.value === preferred)) sel.value = preferred;
    });

    // Pre-populate src MAC with the actual TX interface MAC
    const txMac = _ifaceHwaddrs[els.iface.value];
    if (txMac) els.srcMac.value = txMac;

    // Pre-populate IP field with the existing address on the config interface (if any)
    const existingIp = _ifaceAddrs[els.ifaceConfigIface.value];
    if (existingIp) {
      els.ifaceIp.value = existingIp;
      els.ifacePill.textContent = existingIp;
      els.ifacePill.classList.remove('hidden');
    }
  } catch {
    logTs('Could not fetch interface list — defaulting to eth1.', 'warn');
  }
}

// ─── Build TX packet config ───────────────────────────────────────────────────
function buildConfig() {
  const cfg = {
    src_mac:   els.srcMac.value.trim(),
    dst_mac:   els.dstMac.value.trim(),
    src_ip:    els.srcIp.value.trim(),
    dst_ip:    els.dstIp.value.trim(),
    dscp:      parseInt(els.dscpValue.value) || 0,
    protocol,
    payload:   els.payload.value || 'PktGen',
    interface: els.iface.value,
  };
  if (protocol !== 'icmp') {
    cfg.src_port = parseInt(els.srcPort.value) || 12345;
    cfg.dst_port = parseInt(els.dstPort.value) || 80;
  }
  if (els.vlanEnable.checked) {
    cfg.vlan_id  = parseInt(els.vlanId.value)  || 100;
    cfg.vlan_pcp = parseInt(els.vlanPcp.value) || 0;
  }
  const pktSize = parseInt(els.pktSize.value) || 0;
  if (pktSize > 0) cfg.pkt_size = pktSize;
  return cfg;
}

// ─── TX: Send Fixed ───────────────────────────────────────────────────────────
els.btnSend.addEventListener('click', async () => {
  const cfg = buildConfig();
  cfg.count = parseInt(els.pktCount.value) || 1;
  els.btnSend.disabled = true;
  setStatus('sending', 'SENDING');
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Send failed');
    logTs(`Sent ${data.sent} packet(s) on ${data.interface}`, 'success');
    setStatus('idle', 'IDLE');
  } catch (err) {
    logTs(`Error: ${err.message}`, 'error');
    setStatus('error', 'ERROR');
    setTimeout(() => setStatus('idle', 'IDLE'), 3000);
  } finally {
    els.btnSend.disabled = false;
  }
});

// ─── TX: Start Stream ─────────────────────────────────────────────────────────
els.btnStart.addEventListener('click', async () => {
  const cfg = buildConfig();
  cfg.rate = parseFloat(els.pktRate.value) || 10;
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');
    sending = true;
    els.btnStart.classList.add('hidden');
    els.btnStop.classList.remove('hidden');
    els.liveCounter.classList.remove('hidden');
    setStatus('sending', 'STREAMING');
    logTs(`Stream started on ${data.interface} @ ${data.rate} pps`, 'success');
    startPoll();
  } catch (err) {
    logTs(`Error: ${err.message}`, 'error');
  }
});

// ─── TX: Stop Stream ──────────────────────────────────────────────────────────
els.btnStop.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    const data = await res.json();
    logTs(`Stream stopped. Total sent: ${data.sent}`, 'warn');
  } catch {
    logTs('Stop request failed.', 'error');
  }
  stopPoll();
  sending = false;
  els.btnStop.classList.add('hidden');
  els.btnStart.classList.remove('hidden');
  els.liveCounter.classList.add('hidden');
  setStatus('idle', 'IDLE');
});

// ─── TX: Live Poll ────────────────────────────────────────────────────────────
function startPoll() {
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch('/api/status');
      const data = await res.json();
      els.liveCount.textContent = data.sent.toLocaleString();
      if (!data.sending && sending) els.btnStop.click();
    } catch { /* ignore */ }
  }, 500);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── RX: Capture Table Helpers ────────────────────────────────────────────────
const DSCP_NAMES = {
  0: 'BE', 8: 'CS1', 10: 'AF11', 12: 'AF12', 14: 'AF13',
  16: 'CS2', 18: 'AF21', 20: 'AF22', 22: 'AF23',
  24: 'CS3', 26: 'AF31', 28: 'AF32', 30: 'AF33',
  32: 'CS4', 34: 'AF41', 36: 'AF42', 38: 'AF43',
  40: 'CS5', 46: 'EF', 48: 'CS6', 56: 'CS7',
};

function dscpLabel(v) {
  return DSCP_NAMES[v] != null ? `${DSCP_NAMES[v]}(${v})` : String(v);
}

function dscpClass(v) {
  if (v === 46) return 'dscp-ef';
  if (v >= 32 && v <= 38) return 'dscp-af4';
  if (v >= 24 && v <= 30) return 'dscp-af3';
  if (v >= 16 && v <= 22) return 'dscp-af2';
  if (v >= 8  && v <= 14) return 'dscp-af1';
  return 'dscp-cs';
}

function fmtEndpoint(ip, port) {
  return port != null ? `${ip}:${port}` : ip;
}

function appendCaptureRows(packets) {
  const wrap = els.captureWrap;
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;

  const empty = $('captureEmpty');
  if (empty) empty.remove();

  const frag = document.createDocumentFragment();
  for (const p of packets) {
    const tr = document.createElement('tr');
    const protoClass = `proto-${p.protocol.toLowerCase()}`;
    tr.innerHTML =
      `<td class="col-id">${p.id}</td>` +
      `<td class="col-time">${p.time}</td>` +
      `<td class="col-proto ${protoClass}">${p.protocol}</td>` +
      `<td class="col-src">${fmtEndpoint(p.src_ip, p.src_port)}</td>` +
      `<td class="col-dst">${fmtEndpoint(p.dst_ip, p.dst_port)}</td>` +
      `<td class="col-dscp ${dscpClass(p.dscp)}">${dscpLabel(p.dscp)}</td>` +
      `<td class="col-vlan">${p.vlan != null ? p.vlan : '—'}</td>` +
      `<td class="col-len">${p.length}</td>`;
    frag.appendChild(tr);
  }
  els.captureBody.appendChild(frag);

  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}

// ─── RX: Start Capture ────────────────────────────────────────────────────────
els.btnRxStart.addEventListener('click', async () => {
  const req = {
    interface: els.rxIface.value,
    protocol:  rxProto,
    port:      els.rxPort.value ? parseInt(els.rxPort.value) : null,
  };
  try {
    const res = await fetch('/api/rx/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');

    rxReceiving = true;
    rxLastId    = 0;
    els.btnRxStart.classList.add('hidden');
    els.btnRxStop.classList.remove('hidden');
    els.rxLiveCounter.classList.remove('hidden');
    setRxStatus('receiving', 'LISTEN');
    const portStr = req.port ? `:${req.port}` : '';
    logTs(`RX started on ${data.interface} — filter: ${rxProto}${portStr}`, 'success');
    startRxPoll();
  } catch (err) {
    logTs(`RX error: ${err.message}`, 'error');
  }
});

// ─── RX: Stop Capture ─────────────────────────────────────────────────────────
els.btnRxStop.addEventListener('click', async () => {
  try {
    const res  = await fetch('/api/rx/stop', { method: 'POST' });
    const data = await res.json();
    logTs(`RX stopped. Total captured: ${data.count}`, 'warn');
  } catch {
    logTs('RX stop request failed.', 'error');
  }
  stopRxPoll();
  rxReceiving = false;
  els.btnRxStop.classList.add('hidden');
  els.btnRxStart.classList.remove('hidden');
  els.rxLiveCounter.classList.add('hidden');
  setRxStatus('idle', 'IDLE');
});

// ─── RX: Clear Buffer ─────────────────────────────────────────────────────────
els.btnRxClear.addEventListener('click', async () => {
  try {
    const res  = await fetch('/api/rx/packets', { method: 'DELETE' });
    const data = await res.json();
    rxLastId = data.baseline;
    els.captureBody.innerHTML =
      '<tr id="captureEmpty"><td colspan="8" class="capture-empty-msg">No packets captured — start receiver to begin.</td></tr>';
    if (rxReceiving) els.rxLiveCount.textContent = '0';
    logTs('Capture buffer cleared.', 'warn');
  } catch (err) {
    logTs(`Clear error: ${err.message}`, 'error');
  }
});

// ─── RX: Live Poll ────────────────────────────────────────────────────────────
function startRxPoll() {
  rxPollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`/api/rx/packets?since=${rxLastId}`);
      const data = await res.json();
      if (data.packets.length > 0) {
        appendCaptureRows(data.packets);
        rxLastId = data.packets[data.packets.length - 1].id;
      }
      els.rxLiveCount.textContent = data.count.toLocaleString();
      if (!data.receiving && rxReceiving) els.btnRxStop.click();
    } catch { /* ignore */ }
  }, 500);
}

function stopRxPoll() {
  if (rxPollTimer) { clearInterval(rxPollTimer); rxPollTimer = null; }
}

// ─── Socket Listener: Start ───────────────────────────────────────────────────
els.btnListenerStart.addEventListener('click', async () => {
  const req = {
    protocol: listenerProto,
    port:     parseInt(els.listenerPort.value) || 8888,
    bind_ip:  els.listenerBindIp.value.trim() || '0.0.0.0',
  };
  try {
    const res = await fetch('/api/listener/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');
    listenerRunning = true;
    els.btnListenerStart.classList.add('hidden');
    els.btnListenerStop.classList.remove('hidden');
    els.listenerStats.classList.remove('hidden');
    els.listenerCount.textContent = '0';
    setRxStatus('receiving', 'LISTEN');
    logTs(`Listener: ${data.message}`, 'success');
    startListenerPoll();
  } catch (err) {
    logTs(`Listener error: ${err.message}`, 'error');
  }
});

// ─── Socket Listener: Stop ────────────────────────────────────────────────────
els.btnListenerStop.addEventListener('click', async () => {
  try {
    const res  = await fetch('/api/listener/stop', { method: 'POST' });
    const data = await res.json();
    const noun = listenerProto === 'tcp' ? 'connections' : 'datagrams';
    logTs(`Listener stopped. Total ${noun}: ${data.count}`, 'warn');
  } catch {
    logTs('Listener stop request failed.', 'error');
  }
  stopListenerPoll();
  listenerRunning = false;
  els.btnListenerStop.classList.add('hidden');
  els.btnListenerStart.classList.remove('hidden');
  els.listenerStats.classList.add('hidden');
  setRxStatus('idle', 'IDLE');
});

// ─── Socket Listener: Poll ────────────────────────────────────────────────────
function startListenerPoll() {
  listenerPollTimer = setInterval(async () => {
    try {
      const res  = await fetch('/api/listener/status');
      const data = await res.json();
      els.listenerCount.textContent = data.count.toLocaleString();
      if (!data.listening && listenerRunning) els.btnListenerStop.click();
    } catch { /* ignore */ }
  }, 500);
}

function stopListenerPoll() {
  if (listenerPollTimer) { clearInterval(listenerPollTimer); listenerPollTimer = null; }
}

// ─── Download PCAP ────────────────────────────────────────────────────────────
els.btnDownloadPcap.addEventListener('click', () => {
  window.location.href = '/api/rx/pcap';
});

// ─── Clear Log ────────────────────────────────────────────────────────────────
els.btnClear.addEventListener('click', () => { els.logOutput.innerHTML = ''; });

// ─── Init ─────────────────────────────────────────────────────────────────────
loadInterfaces();
logTs('PktGen ready.', 'info');
