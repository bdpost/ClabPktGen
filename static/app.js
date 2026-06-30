'use strict';

// ─── Multi-stream TX State ────────────────────────────────────────────────────
let streamProto = 'udp';
const _streamPolls = {};   // stream_id → intervalId

// ─── RX State ─────────────────────────────────────────────────────────────────
let rxProto     = 'all';
let rxLastId    = 0;
let rxPollTimer = null;
let rxReceiving = false;

// ─── Listener State ───────────────────────────────────────────────────────────
let listenerProto     = 'tcp';
let listenerPollTimer = null;
let listenerRunning   = false;

// ─── iperf3 State ─────────────────────────────────────────────────────────────
let iperfMode      = 'client';
let iperfProto     = 'tcp';
let iperfDir       = 'normal';
let iperfPollTimer = null;
let iperfRunning   = false;
let iperfSince     = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  // Shared TX base config (left column)
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
  // Add Stream form
  btnToggleAddStream: $('btnToggleAddStream'),
  addStreamForm:      $('addStreamForm'),
  streamSrcPort:      $('streamSrcPort'),
  streamDstPort:      $('streamDstPort'),
  streamDscpValue:    $('streamDscpValue'),
  streamDscpSelect:   $('streamDscpSelect'),
  streamRate:         $('streamRate'),
  streamPktSize:      $('streamPktSize'),
  streamPayload:      $('streamPayload'),
  streamIface:        $('streamIface'),
  streamPktCount:     $('streamPktCount'),
  btnSendStream:      $('btnSendStream'),
  btnAddStream:       $('btnAddStream'),
  // Active streams
  streamList:         $('streamList'),
  streamListEmpty:    $('streamListEmpty'),
  streamCount:        $('streamCount'),
  btnStopAllStreams:  $('btnStopAllStreams'),
  // TX status badge
  statusBadge:      $('statusBadge'),
  statusText:       $('statusText'),
  // Interface config
  ifaceConfigIface: $('ifaceConfigIface'),
  ifaceIp:          $('ifaceIp'),
  ifacePill:        $('ifacePill'),
  btnGetIp:         $('btnGetIp'),
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
  btnRxGetIp:         $('btnRxGetIp'),
  btnRxIfaceUp:       $('btnRxIfaceUp'),
  btnRxIfaceDown:     $('btnRxIfaceDown'),
  // Socket listener
  listenerPort:       $('listenerPort'),
  listenerBindIp:     $('listenerBindIp'),
  btnListenerStart:   $('btnListenerStart'),
  btnListenerStop:    $('btnListenerStop'),
  listenerStats:      $('listenerStats'),
  listenerIdleMsg:    $('listenerIdleMsg'),
  listenerCountMsg:   $('listenerCountMsg'),
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
  // iperf3
  iperfIface:         $('iperfIface'),
  iperfHost:          $('iperfHost'),
  iperfClientPort:    $('iperfClientPort'),
  iperfDuration:      $('iperfDuration'),
  iperfParallel:      $('iperfParallel'),
  iperfBandwidth:     $('iperfBandwidth'),
  iperfServerPort:    $('iperfServerPort'),
  iperfOneOff:        $('iperfOneOff'),
  iperfClientFields:  $('iperfClientFields'),
  iperfServerFields:  $('iperfServerFields'),
  btnIperfStart:      $('btnIperfStart'),
  btnIperfStop:       $('btnIperfStop'),
  iperfOutput:        $('iperfOutput'),
  btnIperfClear:      $('btnIperfClear'),
  iperfLiveCounter:   $('iperfLiveCounter'),
  iperfLineCount:     $('iperfLineCount'),
  iperfStatusBadge:   $('iperfStatusBadge'),
  iperfStatusText:    $('iperfStatusText'),
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

function setIperfStatus(state, text) {
  els.iperfStatusBadge.className = `status-badge ${state}`;
  els.iperfStatusText.textContent = text;
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

// ─── Stream protocol toggle ───────────────────────────────────────────────────
wireSegGroup('streamProtoGroup', val => { streamProto = val; });

// ─── Stream DSCP quick-select ─────────────────────────────────────────────────
els.streamDscpSelect.addEventListener('change', () => {
  if (els.streamDscpSelect.value !== '') {
    els.streamDscpValue.value = els.streamDscpSelect.value;
    els.streamDscpSelect.value = '';
  }
});

// ─── Toggle Add Stream form ───────────────────────────────────────────────────
els.btnToggleAddStream.addEventListener('click', () => {
  const collapsed = els.addStreamForm.classList.contains('collapsed');
  els.addStreamForm.classList.toggle('collapsed', !collapsed);
  els.btnToggleAddStream.textContent = collapsed ? '– Hide' : '+ Add';
});

// ─── RX Protocol toggle ───────────────────────────────────────────────────────
wireSegGroup('rxProtoGroup', val => { rxProto = val; });

// ─── Listener Protocol toggle ─────────────────────────────────────────────────
wireSegGroup('listenerProtoGroup', val => {
  listenerProto = val;
  els.listenerCountLabel.textContent = val === 'tcp' ? 'connections' : 'datagrams';
});

// ─── iperf3 Mode toggle ───────────────────────────────────────────────────────
wireSegGroup('iperfModeGroup', val => {
  iperfMode = val;
  els.iperfClientFields.classList.toggle('hidden', val !== 'client');
  els.iperfServerFields.classList.toggle('hidden', val !== 'server');
});

// ─── iperf3 Protocol toggle ───────────────────────────────────────────────────
wireSegGroup('iperfProtoGroup', val => { iperfProto = val; });

// ─── iperf3 Direction toggle ──────────────────────────────────────────────────
wireSegGroup('iperfDirGroup', val => { iperfDir = val; });

// ─── VLAN toggle ──────────────────────────────────────────────────────────────
els.vlanEnable.addEventListener('change', () => {
  els.vlanFields.classList.toggle('collapsed', !els.vlanEnable.checked);
});

// ─── TX interface change → update src MAC ─────────────────────────────────────
els.streamIface.addEventListener('change', () => {
  const mac = _ifaceHwaddrs[els.streamIface.value];
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

// ─── Get IP buttons ───────────────────────────────────────────────────────────
async function fetchIfaceAddr(iface, ipEl, pillEl) {
  try {
    const res = await fetch('/api/interfaces');
    const { addrs } = await res.json();
    _ifaceAddrs = { ..._ifaceAddrs, ...addrs };
    const ip = addrs[iface];
    if (ip) {
      ipEl.value = ip;
      pillEl.textContent = ip;
      pillEl.classList.remove('hidden');
      logTs(`${iface} → ${ip}`, 'success');
    } else {
      logTs(`No IP assigned on ${iface}`, 'warn');
    }
  } catch (err) {
    logTs(`Get IP error: ${err.message}`, 'error');
  }
}

els.btnGetIp.addEventListener('click', () =>
  fetchIfaceAddr(els.ifaceConfigIface.value, els.ifaceIp, els.ifacePill));

els.btnRxGetIp.addEventListener('click', () =>
  fetchIfaceAddr(els.rxIfaceSelect.value, els.rxIfaceIp, els.rxIfacePill));

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
      body: JSON.stringify({ ip, interface: els.streamIface.value }),
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

    [els.streamIface, els.ifaceConfigIface, els.routeIface, els.rxIface, els.rxIfaceSelect, els.rxRouteIface].forEach(sel => {
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

    // iperf3 source interface — prepend "any" option then list interfaces
    els.iperfIface.innerHTML = '<option value="">— any (default) —</option>';
    interfaces.forEach(iface => {
      const opt = document.createElement('option');
      opt.value = iface;
      const ip = _ifaceAddrs[iface];
      opt.textContent = ip ? `${iface}  (${ip.split('/')[0]})` : iface;
      els.iperfIface.appendChild(opt);
    });

    // Pre-populate src MAC with the TX interface MAC
    const txMac = _ifaceHwaddrs[els.streamIface.value];
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

// ─── Build shared base config (MACs, IPs, VLAN) ──────────────────────────────
function buildBaseConfig() {
  const cfg = {
    src_mac: els.srcMac.value.trim(),
    dst_mac: els.dstMac.value.trim(),
    src_ip:  els.srcIp.value.trim(),
    dst_ip:  els.dstIp.value.trim(),
  };
  if (els.vlanEnable.checked) {
    cfg.vlan_id  = parseInt(els.vlanId.value)  || 100;
    cfg.vlan_pcp = parseInt(els.vlanPcp.value) || 0;
  }
  return cfg;
}

// ─── Build full stream payload (base + per-stream fields) ─────────────────────
function buildStreamPayload() {
  const cfg = buildBaseConfig();
  cfg.protocol  = streamProto;
  cfg.src_port  = parseInt(els.streamSrcPort.value)   || 12345;
  cfg.dst_port  = parseInt(els.streamDstPort.value)   || 8000;
  cfg.dscp      = parseInt(els.streamDscpValue.value) || 0;
  cfg.rate      = parseFloat(els.streamRate.value)    || 10;
  cfg.payload   = els.streamPayload.value || 'PktGen';
  cfg.interface = els.streamIface.value;
  const pktSize = parseInt(els.streamPktSize.value) || 0;
  if (pktSize > 0) cfg.pkt_size = pktSize;
  return cfg;
}

// ─── TX: Send N Packets (quick burst) ────────────────────────────────────────
els.btnSendStream.addEventListener('click', async () => {
  const cfg   = buildStreamPayload();
  const rate  = cfg.rate;
  const iface = cfg.interface;
  // /api/send expects a flat PacketConfig + count + interface
  const body = { ...cfg, count: parseInt(els.streamPktCount.value) || 1 };
  // Remove stream-only fields not in PacketConfig
  delete body.rate;

  els.btnSendStream.disabled = true;
  setStatus('sending', 'SENDING');
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Send failed');
    logTs(`Sent ${data.sent} packet(s) on ${data.interface} — ${streamProto.toUpperCase()} dst:${body.dst_port} DSCP=${body.dscp}`, 'success');
    setStatus('idle', 'IDLE');
  } catch (err) {
    logTs(`Send error: ${err.message}`, 'error');
    setStatus('idle', 'IDLE');
  } finally {
    els.btnSendStream.disabled = false;
  }
});

// ─── TX: Start a new stream ───────────────────────────────────────────────────
els.btnAddStream.addEventListener('click', async () => {
  const cfg = buildStreamPayload();

  els.btnAddStream.disabled = true;
  try {
    const res  = await fetch('/api/streams/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');

    logTs(
      `Stream ${data.stream_id} started — ${streamProto.toUpperCase()} ` +
      `dst:${cfg.dst_port} DSCP=${cfg.dscp} @ ${cfg.rate} pps`,
      'success'
    );

    // Collapse the form
    els.addStreamForm.classList.add('collapsed');
    els.btnToggleAddStream.textContent = '+ Add';

    _beginStreamPoll(data.stream_id, cfg);
    _updateStreamBadge();
  } catch (err) {
    logTs(`Stream start error: ${err.message}`, 'error');
  } finally {
    els.btnAddStream.disabled = false;
  }
});

// ─── TX: Stop All ─────────────────────────────────────────────────────────────
els.btnStopAllStreams.addEventListener('click', async () => {
  try {
    await fetch('/api/streams', { method: 'DELETE' });
    logTs('All streams stopped.', 'warn');
  } catch (err) {
    logTs(`Stop all error: ${err.message}`, 'error');
  }
  Object.keys(_streamPolls).forEach(sid => _removeStreamCard(sid));
});

// ─── TX: Per-stream polling ───────────────────────────────────────────────────
function _beginStreamPoll(streamId, cfg) {
  _upsertStreamCard(streamId, {
    running:  true,
    sent:     0,
    rate:     cfg.rate,
    protocol: cfg.protocol,
    dst_port: cfg.dst_port,
    dscp:     cfg.dscp,
  });

  const intervalId = setInterval(async () => {
    try {
      const res = await fetch(`/api/streams/${streamId}`);
      if (res.status === 404) { _removeStreamCard(streamId); return; }
      const data = await res.json();
      _upsertStreamCard(streamId, data);
      if (!data.running) _removeStreamCard(streamId);
    } catch { /* ignore transient errors */ }
  }, 500);

  _streamPolls[streamId] = intervalId;
}

function _stopStreamPoll(streamId) {
  if (_streamPolls[streamId]) {
    clearInterval(_streamPolls[streamId]);
    delete _streamPolls[streamId];
  }
}

// ─── TX: Render / update a stream card ───────────────────────────────────────
function _upsertStreamCard(streamId, data) {
  let card = $(`stream-card-${streamId}`);
  if (!card) {
    card = document.createElement('div');
    card.id        = `stream-card-${streamId}`;
    card.className = 'stream-card';
    els.streamListEmpty.classList.add('hidden');
    els.streamList.appendChild(card);
  }

  const proto    = (data.protocol || 'udp').toUpperCase();
  const dscp     = data.dscp ?? 0;
  const dscpLbl  = dscpLabel(dscp);
  const dscpCls  = dscpClass(dscp);
  const sent     = (data.sent ?? 0).toLocaleString();
  const rate     = data.rate != null ? `${data.rate} pps` : '?';
  const dstPort  = data.dst_port ?? '?';
  const pBadge   = proto === 'UDP' ? 'proto-badge-udp' : 'proto-badge-tcp';

  card.innerHTML =
    `<div class="stream-card-header">` +
      `<span class="stream-proto-badge ${pBadge}">${proto}</span>` +
      `<span class="stream-card-port">:${dstPort}</span>` +
      `<span class="stream-card-dscp ${dscpCls}">${dscpLbl}</span>` +
      `<span class="stream-card-rate">${rate}</span>` +
      `<button class="stream-card-stop" data-id="${streamId}" title="Stop stream">✕</button>` +
    `</div>` +
    `<div class="stream-card-stats">` +
      `<span class="pulse-dot"></span>` +
      `<span class="stream-card-sent">${sent} pkts</span>` +
      `<span class="stream-card-id">${streamId}</span>` +
    `</div>`;

  card.querySelector('.stream-card-stop').addEventListener('click', () => stopStream(streamId));
}

// ─── TX: Stop a single stream ─────────────────────────────────────────────────
async function stopStream(streamId) {
  try {
    const res  = await fetch(`/api/streams/${streamId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok && res.status !== 404) throw new Error(data.detail || 'Stop failed');
    logTs(`Stream ${streamId} stopped. Sent: ${data.sent ?? '?'}`, 'warn');
  } catch (err) {
    logTs(`Stop stream ${streamId}: ${err.message}`, 'error');
  }
  _removeStreamCard(streamId);
}

function _removeStreamCard(streamId) {
  _stopStreamPoll(streamId);
  const card = $(`stream-card-${streamId}`);
  if (card) card.remove();
  if (!els.streamList.querySelector('.stream-card')) {
    els.streamListEmpty.classList.remove('hidden');
  }
  _updateStreamBadge();
}

function _updateStreamBadge() {
  const count = Object.keys(_streamPolls).length;
  if (count > 0) {
    setStatus('sending', `${count} STREAM${count > 1 ? 'S' : ''}`);
    els.streamCount.textContent = count;
    els.streamCount.classList.remove('hidden');
    els.btnStopAllStreams.classList.toggle('hidden', count < 2);
  } else {
    setStatus('idle', 'IDLE');
    els.streamCount.classList.add('hidden');
    els.btnStopAllStreams.classList.add('hidden');
  }
}

// ─── DSCP helpers (shared by TX cards and RX capture table) ──────────────────
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

// ─── RX: Capture Table ────────────────────────────────────────────────────────
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
    els.listenerIdleMsg.classList.remove('hidden');
    els.listenerCountMsg.classList.add('hidden');
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
      if (data.count > 0) {
        els.listenerIdleMsg.classList.add('hidden');
        els.listenerCountMsg.classList.remove('hidden');
        els.listenerCount.textContent = data.count.toLocaleString();
      } else {
        els.listenerIdleMsg.classList.remove('hidden');
        els.listenerCountMsg.classList.add('hidden');
      }
      if (!data.listening && listenerRunning) els.btnListenerStop.click();
    } catch { /* ignore */ }
  }, 500);
}

function stopListenerPoll() {
  if (listenerPollTimer) { clearInterval(listenerPollTimer); listenerPollTimer = null; }
}

// ─── iperf3: Output Append ────────────────────────────────────────────────────
function appendIperfLines(lines) {
  if (!lines.length) return;
  const atBottom = els.iperfOutput.scrollHeight - els.iperfOutput.scrollTop
                   - els.iperfOutput.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    frag.appendChild(div);
  }
  els.iperfOutput.appendChild(frag);
  if (atBottom) els.iperfOutput.scrollTop = els.iperfOutput.scrollHeight;
}

// ─── iperf3: Start ────────────────────────────────────────────────────────────
els.btnIperfStart.addEventListener('click', async () => {
  const body = { mode: iperfMode };
  if (iperfMode === 'client') {
    const host = els.iperfHost.value.trim();
    if (!host) { logTs('Target host is required for iperf3 client.', 'warn'); return; }
    body.host        = host;
    body.port        = parseInt(els.iperfClientPort.value) || 5201;
    body.protocol    = iperfProto;
    body.duration    = parseInt(els.iperfDuration.value) || 10;
    body.bandwidth   = els.iperfBandwidth.value.trim();
    body.parallel    = parseInt(els.iperfParallel.value) || 1;
    body.reverse     = iperfDir === 'reverse';
    body.bind_iface  = els.iperfIface.value;
  } else {
    body.port    = parseInt(els.iperfServerPort.value) || 5201;
    body.one_off = els.iperfOneOff.checked;
  }

  els.btnIperfStart.disabled = true;
  try {
    const res  = await fetch('/api/iperf3/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Start failed');
    iperfRunning = true;
    iperfSince   = 0;
    els.btnIperfStart.classList.add('hidden');
    els.btnIperfStop.classList.remove('hidden');
    els.iperfLiveCounter.classList.remove('hidden');
    els.btnIperfStart.disabled = false;
    setIperfStatus('sending', 'RUNNING');
    const bindNote = data.bind_ip ? ` (bind ${data.bind_ip})` : '';
    logTs(`iperf3: ${data.message}${bindNote}`, 'success');
    startIperfPoll();
  } catch (err) {
    logTs(`iperf3 error: ${err.message}`, 'error');
    els.btnIperfStart.disabled = false;
  }
});

// ─── iperf3: Stop ─────────────────────────────────────────────────────────────
els.btnIperfStop.addEventListener('click', async () => {
  try {
    const res  = await fetch('/api/iperf3/stop', { method: 'POST' });
    const data = await res.json();
    logTs(`iperf3 stopped. Lines collected: ${data.lines}`, 'warn');
  } catch {
    logTs('iperf3 stop request failed.', 'error');
  }
  _iperfStopped();
});

function _iperfStopped() {
  stopIperfPoll();
  iperfRunning = false;
  els.btnIperfStop.classList.add('hidden');
  els.btnIperfStart.classList.remove('hidden');
  els.iperfLiveCounter.classList.add('hidden');
  setIperfStatus('idle', 'IDLE');
}

// ─── iperf3: Clear Output ─────────────────────────────────────────────────────
els.btnIperfClear.addEventListener('click', () => {
  els.iperfOutput.innerHTML = '';
  iperfSince = 0;
});

// ─── iperf3: Polling ──────────────────────────────────────────────────────────
function startIperfPoll() {
  iperfPollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`/api/iperf3/output?since=${iperfSince}`);
      const data = await res.json();
      if (data.lines.length > 0) {
        appendIperfLines(data.lines);
        iperfSince = data.count;
      }
      els.iperfLineCount.textContent = data.count.toLocaleString();
      if (!data.running && iperfRunning) {
        logTs('iperf3 finished.', 'success');
        _iperfStopped();
      }
    } catch { /* ignore transient poll errors */ }
  }, 500);
}

function stopIperfPoll() {
  if (iperfPollTimer) { clearInterval(iperfPollTimer); iperfPollTimer = null; }
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
