import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const root = document.getElementById('root');

const STATUS_LABELS = {
  abierto: 'Abierto',
  en_proceso: 'En proceso',
  en_espera: 'En espera',
  cerrado: 'Cerrado',
};

const state = {
  session: null,
  profile: null,
  view: 'tickets',
  currentTicketId: null,
  groups: [],
  categories: [],
  loading: true,
  error: null,
};

// ============================================================
// Helpers
// ============================================================
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('es-GT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function statusPill(status) {
  return `<span class="status-pill status-${status}"><span class="led"></span>${STATUS_LABELS[status] || status}</span>`;
}

async function loadProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*, groups:group_id(id, nombre)')
    .eq('id', state.session.user.id)
    .single();
  if (error) { console.error(error); return null; }
  return data;
}

async function loadAccessibleGroups() {
  const { data, error } = await supabase.from('groups').select('*').order('nombre');
  if (error) { console.error(error); return []; }
  return data;
}

// ============================================================
// Auth
// ============================================================
async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const correo = form.correo.value.trim();
  const password = form.password.value;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Ingresando…';
  state.error = null;

  const { data, error } = await supabase.auth.signInWithPassword({ email: correo, password });
  if (error) {
    state.error = error.message === 'Invalid login credentials'
      ? 'Correo o contraseña incorrectos.'
      : error.message;
    renderRoot();
    return;
  }
  state.session = data.session;
  await bootstrapApp();
}

async function handleLogout() {
  await supabase.auth.signOut();
  state.session = null;
  state.profile = null;
  state.view = 'tickets';
  renderRoot();
}

// ============================================================
// Views: Login
// ============================================================
function renderLogin() {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><span class="dot"></span><span>Mesa de Ayuda</span></div>
        <h1>Iniciar sesión</h1>
        <p class="sub">Ingresa con la cuenta que te asignó tu administrador.</p>
        ${state.error ? `<div class="error-msg">${esc(state.error)}</div>` : ''}
        <form id="login-form">
          <div class="field">
            <label for="correo">Correo</label>
            <input id="correo" name="correo" type="email" required autocomplete="username" />
          </div>
          <div class="field">
            <label for="password">Contraseña</label>
            <input id="password" name="password" type="password" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary">Ingresar</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('login-form').addEventListener('submit', handleLogin);
}

// ============================================================
// App shell
// ============================================================
function navItemsForRole(role) {
  const items = [{ id: 'tickets', label: role === 'usuario' ? 'Mis tickets' : 'Tickets' }];
  if (role === 'admin' || role === 'supervisor') items.push({ id: 'categories', label: 'Categorías' });
  if (role === 'admin' || role === 'supervisor') items.push({ id: 'users', label: 'Usuarios' });
  if (role === 'admin') items.push({ id: 'groups', label: 'Grupos' });
  return items;
}

function renderShell(contentHtml) {
  const p = state.profile;
  const items = navItemsForRole(p.rol);
  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><span class="dot"></span><span>Mesa de Ayuda</span></div>
        <nav>
          ${items.map(it => `
            <button class="nav-item ${state.view === it.id ? 'active' : ''}" data-nav="${it.id}">${esc(it.label)}</button>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="user-chip">
            <span class="name">${esc(p.nombre)}</span>
            <span class="role">${esc(p.rol)}${p.groups ? ' · ' + esc(p.groups.nombre) : ''}</span>
          </div>
          <button class="btn btn-secondary" id="logout-btn" style="width:100%">Cerrar sesión</button>
        </div>
      </aside>
      <main class="main">${contentHtml}</main>
    </div>
  `;
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  root.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => { state.view = btn.dataset.nav; state.currentTicketId = null; renderRoot(); });
  });
}

// ============================================================
// View: Tickets list
// ============================================================
let ticketFilters = { status: '', group_id: '' };

async function renderTickets() {
  const isUser = state.profile.rol === 'usuario';
  renderShell(`<div class="loading-line">Cargando tickets…</div>`);

  let query = supabase.from('tickets')
    .select('id, folio, asunto, status, created_at, group_id, groups:group_id(nombre), categories:category_id(nombre), created_by, profiles:created_by(nombre)')
    .order('created_at', { ascending: false });

  if (ticketFilters.status) query = query.eq('status', ticketFilters.status);
  if (ticketFilters.group_id) query = query.eq('group_id', ticketFilters.group_id);

  const { data: tickets, error } = await query;
  if (error) { console.error(error); }

  const groupFilterHtml = !isUser ? `
    <select id="filter-group">
      <option value="">Todos los grupos</option>
      ${state.groups.map(g => `<option value="${g.id}" ${ticketFilters.group_id === g.id ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('')}
    </select>` : '';

  const content = `
    <div class="main-header">
      <div>
        <h1>${isUser ? 'Mis tickets' : 'Tickets'}</h1>
        <p>${isUser ? 'Tickets que has creado' : 'Tickets visibles según tus grupos asignados'}</p>
      </div>
      ${isUser ? `<button class="btn btn-primary" id="new-ticket-btn">+ Nuevo ticket</button>` : ''}
    </div>
    <div class="toolbar">
      <select id="filter-status">
        <option value="">Todos los estados</option>
        ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${ticketFilters.status === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      ${groupFilterHtml}
    </div>
    <div class="card" style="padding:0">
      <div class="ticket-row head">
        <span>Folio</span><span>Asunto</span><span>Grupo</span><span>Creado</span><span>Estado</span>
      </div>
      ${(!tickets || tickets.length === 0) ? `
        <div class="empty-state">
          <div class="glyph">— sin resultados —</div>
          <p>No hay tickets que coincidan con este filtro.</p>
        </div>` : tickets.map(t => `
        <div class="ticket-row" data-ticket="${t.id}">
          <span class="folio">#${t.folio}</span>
          <span class="ticket-subject">${esc(t.asunto)}<span class="meta">${esc(t.categories?.nombre || 'Sin categoría')} · ${esc(t.profiles?.nombre || '')}</span></span>
          <span>${esc(t.groups?.nombre || '')}</span>
          <span class="folio">${fmtDate(t.created_at)}</span>
          ${statusPill(t.status)}
        </div>
      `).join('')}
    </div>
  `;
  renderShell(content);

  document.getElementById('filter-status').addEventListener('change', (e) => { ticketFilters.status = e.target.value; renderTickets(); });
  const gf = document.getElementById('filter-group');
  if (gf) gf.addEventListener('change', (e) => { ticketFilters.group_id = e.target.value; renderTickets(); });
  const nb = document.getElementById('new-ticket-btn');
  if (nb) nb.addEventListener('click', openNewTicketModal);
  root.querySelectorAll('[data-ticket]').forEach(row => {
    row.addEventListener('click', () => { state.currentTicketId = row.dataset.ticket; state.view = 'ticket-detail'; renderRoot(); });
  });
}

async function openNewTicketModal() {
  const myGroupId = state.profile.group_id;
  const { data: cats } = await supabase.from('categories').select('*').eq('group_id', myGroupId).order('nombre');
  showModal(`
    <h2>Nuevo ticket</h2>
    <form id="new-ticket-form">
      <div class="field">
        <label>Asunto</label>
        <input name="asunto" required maxlength="150" />
      </div>
      <div class="field">
        <label>Categoría</label>
        <select name="category_id" required>
          <option value="" disabled selected>Selecciona una categoría</option>
          ${(cats || []).map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Descripción</label>
        <textarea name="descripcion" rows="5" required></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="modal-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Crear ticket</button>
      </div>
    </form>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('new-ticket-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await supabase.from('tickets').insert({
      asunto: f.asunto.value.trim(),
      descripcion: f.descripcion.value.trim(),
      category_id: f.category_id.value,
      group_id: myGroupId,
      created_by: state.profile.id,
    });
    if (error) { alert('Error al crear el ticket: ' + error.message); return; }
    closeModal();
    renderTickets();
  });
}

// ============================================================
// View: Ticket detail
// ============================================================
async function renderTicketDetail() {
  renderShell(`<div class="loading-line">Cargando ticket…</div>`);
  const id = state.currentTicketId;

  const [{ data: ticket, error }, { data: comments }, { data: attachments }] = await Promise.all([
    supabase.from('tickets').select('*, groups:group_id(nombre), categories:category_id(nombre), profiles:created_by(nombre, correo), assignee:assigned_to(id, nombre)').eq('id', id).single(),
    supabase.from('ticket_comments').select('*, profiles:author_id(nombre)').eq('ticket_id', id).order('created_at'),
    supabase.from('ticket_attachments').select('*, profiles:uploaded_by(nombre)').eq('ticket_id', id).order('created_at'),
  ]);

  if (error || !ticket) {
    renderShell(`<div class="empty-state">No se pudo cargar el ticket o no tienes acceso.</div>`);
    return;
  }

  const canManage = ['admin', 'supervisor', 'agente'].includes(state.profile.rol);

  let agentOptions = '';
  if (canManage) {
    const { data: groupStaff } = await supabase
      .from('group_access')
      .select('user_id, profiles:user_id(id, nombre, rol)')
      .eq('group_id', ticket.group_id);
    agentOptions = (groupStaff || [])
      .filter(gs => gs.profiles && ['agente', 'supervisor'].includes(gs.profiles.rol))
      .map(gs => `<option value="${gs.profiles.id}" ${ticket.assigned_to === gs.profiles.id ? 'selected' : ''}>${esc(gs.profiles.nombre)} (${esc(gs.profiles.rol)})</option>`)
      .join('');
  }

  const content = `
    <div class="main-header">
      <div>
        <h1><span class="folio">#${ticket.folio}</span> &nbsp;${esc(ticket.asunto)}</h1>
        <p>${esc(ticket.groups?.nombre || '')} · ${esc(ticket.categories?.nombre || 'Sin categoría')} · creado por ${esc(ticket.profiles?.nombre || '')} el ${fmtDate(ticket.created_at)}</p>
      </div>
      <button class="btn btn-secondary" id="back-btn">← Volver</button>
    </div>
    <div class="detail-grid">
      <div>
        <div class="card" style="margin-bottom:18px">
          <div class="kv"><span class="k">Descripción</span>${esc(ticket.descripcion).replace(/\n/g, '<br>')}</div>
        </div>

        <div class="card" style="margin-bottom:18px">
          <h2 style="font-family:var(--font-display);font-size:15px;margin:0 0 12px">Adjuntos</h2>
          <div id="attachments-list">
            ${(!attachments || attachments.length === 0) ? `<p style="color:var(--text-faint);font-size:13px">Sin adjuntos.</p>` : attachments.map(a => `
              <div class="attachment-item">
                <span>${esc(a.file_name)} <span style="color:var(--text-faint)">· ${esc(a.profiles?.nombre || '')}</span></span>
                <a href="#" data-download="${a.id}" data-path="${esc(a.file_path)}">Descargar</a>
              </div>
            `).join('')}
          </div>
          <div style="margin-top:12px">
            <input type="file" id="attachment-input" />
          </div>
        </div>

        <div class="card">
          <h2 style="font-family:var(--font-display);font-size:15px;margin:0 0 12px">Comentarios</h2>
          <div id="comments-list">
            ${(!comments || comments.length === 0) ? `<p style="color:var(--text-faint);font-size:13px">Aún no hay comentarios.</p>` : comments.map(c => `
              <div class="comment">
                <div class="comment-head"><span>${esc(c.profiles?.nombre || '')}</span><span>${fmtDate(c.created_at)}</span></div>
                <div class="comment-body">${esc(c.comentario).replace(/\n/g, '<br>')}</div>
              </div>
            `).join('')}
          </div>
          <form id="comment-form" style="margin-top:14px">
            <div class="field"><textarea name="comentario" rows="3" placeholder="Escribe un comentario…" required></textarea></div>
            <button type="submit" class="btn btn-primary">Comentar</button>
          </form>
        </div>
      </div>

      <div class="sidebar-panel">
        <div class="card">
          <div class="kv"><span class="k">Estado</span>${statusPill(ticket.status)}</div>
          ${canManage ? `
            <div class="field" style="margin-top:10px">
              <label>Cambiar estado</label>
              <select id="status-select">
                ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${ticket.status === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
          ` : ''}
          <div class="kv" style="margin-top:14px"><span class="k">Agente asignado</span>${ticket.assignee ? esc(ticket.assignee.nombre) : 'Sin asignar'}</div>
          ${canManage ? `
            <div class="field" style="margin-top:10px">
              <label>Reasignar</label>
              <select id="assignee-select">
                <option value="">Sin asignar</option>
                ${agentOptions}
              </select>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
  renderShell(content);

  document.getElementById('back-btn').addEventListener('click', () => { state.view = 'tickets'; renderRoot(); });

  const statusSelect = document.getElementById('status-select');
  if (statusSelect) {
    statusSelect.addEventListener('change', async (e) => {
      const { error } = await supabase.from('tickets').update({ status: e.target.value }).eq('id', id);
      if (error) alert('No se pudo actualizar el estado: ' + error.message);
      else renderTicketDetail();
    });
  }

  document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.comentario.value.trim();
    if (!text) return;
    const { error } = await supabase.from('ticket_comments').insert({ ticket_id: id, author_id: state.profile.id, comentario: text });
    if (error) { alert('No se pudo agregar el comentario: ' + error.message); return; }
    renderTicketDetail();
  });

  const assigneeSelect = document.getElementById('assignee-select');
  if (assigneeSelect) {
    assigneeSelect.addEventListener('change', async (e) => {
      const { error } = await supabase.from('tickets').update({ assigned_to: e.target.value || null }).eq('id', id);
      if (error) alert('No se pudo asignar: ' + error.message);
      else renderTicketDetail();
    });
  }

  document.getElementById('attachment-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const path = `${id}/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage.from('attachments').upload(path, file);
    if (upErr) { alert('No se pudo subir el archivo: ' + upErr.message); return; }
    const { error: insErr } = await supabase.from('ticket_attachments').insert({
      ticket_id: id, file_path: path, file_name: file.name, uploaded_by: state.profile.id,
    });
    if (insErr) { alert('Archivo subido pero no se pudo registrar: ' + insErr.message); return; }
    renderTicketDetail();
  });

  root.querySelectorAll('[data-download]').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const path = link.dataset.path;
      const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 60);
      if (error) { alert('No se pudo generar el enlace: ' + error.message); return; }
      window.open(data.signedUrl, '_blank');
    });
  });
}

// ============================================================
// View: Categories (admin / supervisor)
// ============================================================
let selectedCategoryGroup = null;

async function renderCategories() {
  renderShell(`<div class="loading-line">Cargando categorías…</div>`);
  const groups = state.groups;
  if (!selectedCategoryGroup && groups.length) selectedCategoryGroup = groups[0].id;

  const { data: cats } = selectedCategoryGroup
    ? await supabase.from('categories').select('*').eq('group_id', selectedCategoryGroup).order('nombre')
    : { data: [] };

  const content = `
    <div class="main-header">
      <div><h1>Categorías</h1><p>Gestiona las categorías de tickets por grupo</p></div>
    </div>
    <div class="toolbar">
      <select id="cat-group-select">
        ${groups.map(g => `<option value="${g.id}" ${selectedCategoryGroup === g.id ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="add-cat-btn">+ Nueva categoría</button>
    </div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead><tr><th>Nombre</th><th>Creada</th><th></th></tr></thead>
        <tbody>
          ${(!cats || cats.length === 0) ? `<tr><td colspan="3" style="color:var(--text-faint)">Sin categorías aún.</td></tr>` : cats.map(c => `
            <tr>
              <td>${esc(c.nombre)}</td>
              <td class="folio">${fmtDate(c.created_at)}</td>
              <td><button class="btn btn-danger" data-del-cat="${c.id}" style="padding:4px 10px;font-size:12px">Eliminar</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  renderShell(content);

  document.getElementById('cat-group-select').addEventListener('change', (e) => { selectedCategoryGroup = e.target.value; renderCategories(); });
  document.getElementById('add-cat-btn').addEventListener('click', () => {
    showModal(`
      <h2>Nueva categoría</h2>
      <form id="new-cat-form">
        <div class="field"><label>Nombre</label><input name="nombre" required maxlength="80" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="modal-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    `);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('new-cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await supabase.from('categories').insert({ nombre: e.target.nombre.value.trim(), group_id: selectedCategoryGroup });
      if (error) { alert('No se pudo crear: ' + error.message); return; }
      closeModal();
      renderCategories();
    });
  });
  root.querySelectorAll('[data-del-cat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta categoría?')) return;
      const { error } = await supabase.from('categories').delete().eq('id', btn.dataset.delCat);
      if (error) { alert('No se pudo eliminar: ' + error.message); return; }
      renderCategories();
    });
  });
}

// ============================================================
// View: Users (admin / supervisor)
// ============================================================
async function renderUsers() {
  renderShell(`<div class="loading-line">Cargando usuarios…</div>`);

  let users = [];
  let accessMap = {};

  if (state.profile.rol === 'admin') {
    const [{ data: allUsers, error }, { data: access }] = await Promise.all([
      supabase.from('profiles').select('*, groups:group_id(nombre)').order('nombre'),
      supabase.from('group_access').select('user_id, groups:group_id(nombre)'),
    ]);
    if (error) console.error(error);
    users = allUsers || [];
    (access || []).forEach(a => {
      if (!a.groups?.nombre) return;
      if (!accessMap[a.user_id]) accessMap[a.user_id] = [];
      accessMap[a.user_id].push(a.groups.nombre);
    });
  } else {
    // Supervisor: solo usuarios y agentes de sus grupos asignados.
    const groupIds = state.groups.map(g => g.id);
    const [{ data: usuarios }, { data: accessRows }] = groupIds.length
      ? await Promise.all([
          supabase.from('profiles').select('*, groups:group_id(nombre)').eq('rol', 'usuario').in('group_id', groupIds),
          supabase.from('group_access').select('user_id, groups:group_id(nombre), profiles:user_id(*)').in('group_id', groupIds),
        ])
      : [{ data: [] }, { data: [] }];

    const agentMap = new Map();
    (accessRows || []).forEach(r => {
      if (r.profiles?.rol === 'agente') agentMap.set(r.profiles.id, r.profiles);
      if (r.profiles && r.groups?.nombre) {
        if (!accessMap[r.user_id]) accessMap[r.user_id] = [];
        accessMap[r.user_id].push(r.groups.nombre);
      }
    });
    users = [...(usuarios || []), ...Array.from(agentMap.values())].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  const content = `
    <div class="main-header">
      <div><h1>Usuarios</h1><p>Perfiles visibles según tu alcance de grupos</p></div>
    </div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead><tr><th>Nombre</th><th>Correo</th><th>Empresa</th><th>Rol</th><th>Grupo(s)</th><th></th></tr></thead>
        <tbody>
          ${(!users || users.length === 0) ? `<tr><td colspan="6" style="color:var(--text-faint)">Sin usuarios.</td></tr>` : users.map(u => {
            const grupoDisplay = u.rol === 'usuario'
              ? esc(u.groups?.nombre || '—')
              : esc((accessMap[u.id] || []).join(', ') || '—');
            return `
            <tr>
              <td>${esc(u.nombre)}</td>
              <td>${esc(u.correo)}</td>
              <td>${esc(u.empresa)}</td>
              <td><span class="tag">${esc(u.rol)}</span></td>
              <td>${grupoDisplay}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-secondary" data-edit-user="${u.id}" style="padding:4px 10px;font-size:12px">Editar</button>
                <button class="btn btn-secondary" data-temp-pw="${u.id}" data-name="${esc(u.nombre)}" style="padding:4px 10px;font-size:12px">Contraseña temporal</button>
                <button class="btn btn-secondary" data-reset-pw="${u.id}" data-email="${esc(u.correo)}" style="padding:4px 10px;font-size:12px">Enviar por correo</button>
              </td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <p style="color:var(--text-faint);font-size:12.5px;margin-top:14px">
      Para crear un usuario nuevo: primero créalo en Supabase (Authentication → Add user), luego edítalo aquí para completar sus datos.
      "Contraseña temporal" te la muestra en pantalla para que se la compartas tú mismo al usuario (no depende de correo); al ingresar con ella, el sistema le pedirá cambiarla.
      "Enviar por correo" le manda un enlace de restablecimiento a su email.
    </p>
  `;
  renderShell(content);

  root.querySelectorAll('[data-edit-user]').forEach(btn => {
    btn.addEventListener('click', () => openEditUserModal(users.find(u => u.id === btn.dataset.editUser)));
  });

  root.querySelectorAll('[data-temp-pw]').forEach(btn => {
    btn.addEventListener('click', () => openTempPasswordModal(btn.dataset.tempPw, btn.dataset.name));
  });

  root.querySelectorAll('[data-reset-pw]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`¿Enviar correo de restablecimiento de contraseña a ${btn.dataset.email}?`)) return;
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await supabase.auth.resetPasswordForEmail(btn.dataset.email, { redirectTo });
      if (error) { alert('No se pudo enviar el correo: ' + error.message); return; }
      alert('Correo de restablecimiento enviado a ' + btn.dataset.email);
    });
  });
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function openTempPasswordModal(userId, userName) {
  showModal(`
    <h2>Contraseña temporal — ${esc(userName)}</h2>
    <p style="color:var(--text-dim);font-size:13px;margin:-8px 0 16px">
      Se la debes compartir tú mismo al usuario. En su próximo inicio de sesión se le pedirá cambiarla.
    </p>
    <form id="temp-pw-form">
      <div class="field">
        <label>Contraseña temporal</label>
        <input name="password" id="temp-pw-input" value="${randomPassword()}" required minlength="6" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="modal-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Definir contraseña</button>
      </div>
    </form>
  `);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('temp-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    const { error } = await supabase.rpc('admin_set_temp_password', { target_id: userId, new_password: password });
    if (error) { alert('No se pudo definir la contraseña: ' + error.message); return; }
    closeModal();
    alert(`Contraseña temporal definida para ${userName}:\n\n${password}\n\nCompártesela directamente — no se enviará por correo.`);
  });
}

async function openEditUserModal(user) {
  const isAdmin = state.profile.rol === 'admin';
  const groupOptions = state.groups.map(g => `<option value="${g.id}" ${user.group_id === g.id ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('');
  const roleOptions = ['usuario', 'agente', 'supervisor', 'admin']
    .filter(r => isAdmin || ['usuario', 'agente'].includes(r))
    .map(r => `<option value="${r}" ${user.rol === r ? 'selected' : ''}>${r}</option>`).join('');

  const { data: currentAccess } = await supabase.from('group_access').select('group_id').eq('user_id', user.id);
  const currentAccessIds = (currentAccess || []).map(a => a.group_id);

  showModal(`
    <h2>Editar usuario</h2>
    <form id="edit-user-form">
      <div class="grid-2">
        <div class="field"><label>Nombre *</label><input name="nombre" required value="${esc(user.nombre)}" /></div>
        <div class="field"><label>Empresa *</label><input name="empresa" required value="${esc(user.empresa)}" /></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Departamento</label><input name="departamento" value="${esc(user.departamento || '')}" /></div>
        <div class="field"><label>N/S de equipo</label><input name="ns_equipo" value="${esc(user.ns_equipo || '')}" /></div>
      </div>
      <div class="field"><label>Rol</label><select name="rol" id="rol-select">${roleOptions}</select></div>
      <div class="field" id="group-single-wrap">
        <label>Grupo (usuario final — pertenece a uno solo)</label>
        <select name="group_id"><option value="">— sin grupo —</option>${groupOptions}</select>
      </div>
      <div class="field" id="group-multi-wrap">
        <label>Grupos con acceso (agente/supervisor — puede ser varios)</label>
        ${!isAdmin ? `<p style="color:var(--text-faint);font-size:12px;margin:0 0 8px">Solo un admin puede cambiar esto.</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:7px;max-height:170px;overflow-y:auto;padding:2px">
          ${state.groups.map(g => `
            <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:400;text-transform:none;letter-spacing:0">
              <input type="checkbox" name="group_access" value="${g.id}" ${currentAccessIds.includes(g.id) ? 'checked' : ''} ${!isAdmin ? 'disabled' : ''} />
              ${esc(g.nombre)}
            </label>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="modal-cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">Guardar</button>
      </div>
    </form>
  `);

  const form = document.getElementById('edit-user-form');
  const roleSelect = document.getElementById('rol-select');
  const singleWrap = document.getElementById('group-single-wrap');
  const multiWrap = document.getElementById('group-multi-wrap');
  function toggleGroupFields() {
    const isUsuario = roleSelect.value === 'usuario';
    singleWrap.style.display = isUsuario ? '' : 'none';
    multiWrap.style.display = isUsuario ? 'none' : '';
  }
  toggleGroupFields();
  roleSelect.addEventListener('change', toggleGroupFields);

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const payload = {
      nombre: f.nombre.value.trim(),
      empresa: f.empresa.value.trim(),
      departamento: f.departamento.value.trim() || null,
      ns_equipo: f.ns_equipo.value.trim() || null,
      rol: f.rol.value,
      group_id: f.rol.value === 'usuario' ? (f.group_id.value || null) : null,
    };
    const { error } = await supabase.from('profiles').update(payload).eq('id', user.id);
    if (error) { alert('No se pudo guardar: ' + error.message); return; }

    if (payload.rol !== 'usuario' && isAdmin) {
      const checked = Array.from(f.querySelectorAll('input[name=group_access]:checked')).map(cb => cb.value);
      const { error: delErr } = await supabase.from('group_access').delete().eq('user_id', user.id);
      if (delErr) { alert('No se pudo actualizar el acceso a grupos (borrado): ' + delErr.message); return; }
      if (checked.length) {
        const { error: insErr } = await supabase.from('group_access').insert(checked.map(gid => ({ user_id: user.id, group_id: gid })));
        if (insErr) { alert('No se pudo actualizar el acceso a grupos (inserción): ' + insErr.message); return; }
      }
    }
    closeModal();
    renderUsers();
  });
}

// ============================================================
// View: Groups (admin only)
// ============================================================
async function renderGroups() {
  renderShell(`<div class="loading-line">Cargando grupos…</div>`);
  const { data: groups } = await supabase.from('groups').select('*').order('nombre');

  const content = `
    <div class="main-header">
      <div><h1>Grupos</h1><p>Áreas o departamentos que atienden tickets</p></div>
      <button class="btn btn-primary" id="add-group-btn">+ Nuevo grupo</button>
    </div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead><tr><th>Nombre</th><th>Creado</th></tr></thead>
        <tbody>
          ${(!groups || groups.length === 0) ? `<tr><td colspan="2" style="color:var(--text-faint)">Sin grupos aún.</td></tr>` : groups.map(g => `
            <tr><td>${esc(g.nombre)}</td><td class="folio">${fmtDate(g.created_at)}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  renderShell(content);

  document.getElementById('add-group-btn').addEventListener('click', () => {
    showModal(`
      <h2>Nuevo grupo</h2>
      <form id="new-group-form">
        <div class="field"><label>Nombre</label><input name="nombre" required maxlength="80" /></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="modal-cancel">Cancelar</button>
          <button type="submit" class="btn btn-primary">Crear</button>
        </div>
      </form>
    `);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('new-group-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { error } = await supabase.from('groups').insert({ nombre: e.target.nombre.value.trim() });
      if (error) { alert('No se pudo crear: ' + error.message); return; }
      closeModal();
      state.groups = await loadAccessibleGroups();
      renderGroups();
    });
  });
}

// ============================================================
// Modal helper
// ============================================================
function showModal(innerHtml) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.id = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal">${innerHtml}</div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeModal(); });
  document.body.appendChild(wrap);
}
function closeModal() {
  const el = document.getElementById('modal-backdrop');
  if (el) el.remove();
}

function renderPasswordRecovery() {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><span class="dot"></span><span>Mesa de Ayuda</span></div>
        <h1>Nueva contraseña</h1>
        <p class="sub">Define tu nueva contraseña para continuar.</p>
        ${state.error ? `<div class="error-msg">${esc(state.error)}</div>` : ''}
        <form id="recovery-form">
          <div class="field">
            <label for="new-password">Nueva contraseña</label>
            <input id="new-password" name="password" type="password" minlength="6" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary">Guardar contraseña</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { state.error = error.message; renderRoot(); return; }
    state.error = null;
    await bootstrapApp();
  });
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    state.session = session;
    state.view = 'password-recovery';
    renderRoot();
  }
});

function renderForcedPasswordChange() {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand"><span class="dot"></span><span>Mesa de Ayuda</span></div>
        <h1>Define tu contraseña</h1>
        <p class="sub">Tu administrador te dio una contraseña temporal. Define una nueva antes de continuar.</p>
        ${state.error ? `<div class="error-msg">${esc(state.error)}</div>` : ''}
        <form id="forced-pw-form">
          <div class="field">
            <label for="forced-password">Nueva contraseña</label>
            <input id="forced-password" name="password" type="password" minlength="6" required autocomplete="new-password" />
          </div>
          <button type="submit" class="btn btn-primary">Guardar y continuar</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById('forced-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { state.error = error.message; renderRoot(); return; }
    await supabase.from('profiles').update({ debe_cambiar_password: false }).eq('id', state.profile.id);
    state.error = null;
    state.profile.debe_cambiar_password = false;
    state.view = 'tickets';
    renderRoot();
  });
}

// ============================================================
// Root render / router
// ============================================================
function renderRoot() {
  if (state.view === 'password-recovery') { renderPasswordRecovery(); return; }
  if (!state.session) { renderLogin(); return; }
  if (!state.profile) { root.innerHTML = `<div class="loading-line" style="padding:40px">Cargando…</div>`; return; }
  if (state.profile.debe_cambiar_password) { renderForcedPasswordChange(); return; }

  if (state.view === 'tickets') renderTickets();
  else if (state.view === 'ticket-detail') renderTicketDetail();
  else if (state.view === 'categories') renderCategories();
  else if (state.view === 'users') renderUsers();
  else if (state.view === 'groups') renderGroups();
  else renderTickets();
}

async function bootstrapApp() {
  state.profile = await loadProfile();
  if (!state.profile) {
    state.error = 'No se encontró tu perfil. Contacta al administrador.';
    await supabase.auth.signOut();
    state.session = null;
    renderRoot();
    return;
  }
  state.groups = await loadAccessibleGroups();
  state.view = 'tickets';
  renderRoot();
}

async function init() {
  // Enlace de restablecimiento de contraseña: verificamos el token nosotros
  // mismos (en vez de que el correo apunte directo al endpoint de Supabase)
  // para que los escáneres de seguridad de Outlook/Gmail no lo consuman antes
  // de que el usuario le dé clic.
  const params = new URLSearchParams(window.location.search);
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (tokenHash && type === 'recovery') {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' });
    window.history.replaceState({}, '', window.location.pathname);
    if (error) {
      state.error = 'El enlace ya no es válido. Pide que te envíen uno nuevo.';
      renderPasswordRecovery();
      return;
    }
    state.session = data.session;
    state.view = 'password-recovery';
    renderRoot();
    return;
  }

  const { data } = await supabase.auth.getSession();
  state.session = data.session;
  if (state.session) {
    await bootstrapApp();
  } else {
    renderRoot();
  }
}

init();
