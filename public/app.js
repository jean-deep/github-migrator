// Lógica del Cliente: GitHub Migrator Dashboard

// Elementos de la UI - Conexión
const patTokenInput = document.getElementById('pat-token');
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const disconnectedState = document.getElementById('disconnected-state');
const connectedState = document.getElementById('connected-state');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const userLogin = document.getElementById('user-login');

// Elementos de la UI - Configuración
const selectOrg = document.getElementById('select-org');
const inputPrefix = document.getElementById('input-prefix');
const visibilityRadios = document.getElementsByName('visibility');

// Elementos de la UI - Lista de Repositorios
const reposPlaceholder = document.getElementById('repos-placeholder');
const reposLoader = document.getElementById('repos-loader');
const reposList = document.getElementById('repos-list');
const repoSearch = document.getElementById('repo-search');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeselectAll = document.getElementById('btn-deselect-all');
const selectedCounter = document.getElementById('selected-counter');

// Elementos de la UI - Progreso y Terminal
const btnStartMigration = document.getElementById('btn-start-migration');
const progressWrapper = document.getElementById('migration-progress-wrapper');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressStatus = document.getElementById('progress-status');
const terminalOutput = document.getElementById('terminal-output');
const btnClearTerminal = document.getElementById('btn-clear-terminal');

// Estado de la Aplicación
let allRepos = []; // Lista completa de repos del usuario
let selectedRepos = new Set(); // Conjunto de nombres de repos seleccionados
let isMigrating = false;
let sseConnection = null;

// Contador de progreso
let totalToMigrate = 0;
let migratedCount = 0;

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
    // Escuchar eventos
    btnConnect.addEventListener('click', connectToGitHub);
    btnDisconnect.addEventListener('click', disconnectFromGitHub);
    repoSearch.addEventListener('input', filterRepos);
    btnSelectAll.addEventListener('click', selectAllFilteredRepos);
    btnDeselectAll.addEventListener('click', deselectAll);
    btnStartMigration.addEventListener('click', startMigration);
    btnClearTerminal.addEventListener('click', clearTerminal);

    // Cargar token previo si existe en LocalStorage
    const savedToken = localStorage.getItem('github_pat');
    if (savedToken) {
        patTokenInput.value = savedToken;
        connectToGitHub();
    }

    // Inicializar conexión SSE para los logs
    setupEventSource();
});

// Establecer conexión SSE
function setupEventSource() {
    if (sseConnection) {
        sseConnection.close();
    }

    sseConnection = new EventSource('/api/logs');
    
    sseConnection.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            appendTerminalLine(data.message, data.type);

            // Manejo de actualización de progreso del frontend mediante SSE
            if (isMigrating && data.repo) {
                if (data.type === 'done' || data.type === 'error') {
                    migratedCount++;
                    updateProgressBar();
                }
                if (data.type === 'progress') {
                    progressStatus.textContent = data.message.replace(/\[\d+\/\d+\]\s*/, '');
                }
            }
        } catch (e) {
            console.error('Error procesando log:', e);
        }
    };

    sseConnection.onerror = () => {
        console.warn('Conexión de logs perdida. Reintentando...');
    };
}

// Conectarse a la API de GitHub local a través del backend
async function connectToGitHub() {
    const token = patTokenInput.value.trim();
    if (!token) {
        alert('Por favor introduce tu token de GitHub.');
        return;
    }

    setAuthLoading(true);

    try {
        const res = await fetch('/api/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Fallo de autenticación');
        }

        // Guardar token en LocalStorage
        localStorage.setItem('github_pat', token);

        // Actualizar UI del perfil
        userAvatar.src = data.avatar;
        userName.textContent = data.name;
        userLogin.textContent = `@${data.username}`;
        
        // Cambiar estados de tarjetas
        disconnectedState.classList.remove('active');
        connectedState.classList.add('active');

        appendTerminalLine(`Conexión exitosa. Bienvenido, ${data.name}!`, 'success');

        // Cargar organizaciones y repositorios
        await Promise.all([loadOrganizations(), loadRepositories()]);

    } catch (err) {
        appendTerminalLine(`Error al conectar: ${err.message}`, 'error');
        localStorage.removeItem('github_pat');
        setAuthLoading(false);
    }
}

// Desconectar cuenta
function disconnectFromGitHub() {
    localStorage.removeItem('github_pat');
    patTokenInput.value = '';
    
    disconnectedState.classList.add('active');
    connectedState.classList.remove('active');
    
    // Resetear controles
    disableControls(true);
    allRepos = [];
    selectedRepos.clear();
    updateSelectedCounter();
    
    // Resetear vistas
    reposList.innerHTML = '';
    reposList.classList.add('hidden');
    reposPlaceholder.classList.remove('hidden');
    
    selectOrg.innerHTML = '<option value="">-- Selecciona una organización --</option>';

    appendTerminalLine('Sesión cerrada correctamente.', 'system');
}

function setAuthLoading(loading) {
    if (loading) {
        btnConnect.disabled = true;
        btnConnect.textContent = 'Conectando...';
        patTokenInput.disabled = true;
    } else {
        btnConnect.disabled = false;
        btnConnect.textContent = 'Conectar';
        patTokenInput.disabled = false;
    }
}

// Cargar Organizaciones en el select
async function loadOrganizations() {
    try {
        const res = await fetch('/api/orgs');
        const orgs = await res.json();
        
        selectOrg.innerHTML = '<option value="">-- Selecciona una organización --</option>';
        
        orgs.forEach(org => {
            const option = document.createElement('option');
            option.value = org.login;
            option.textContent = org.login;
            selectOrg.appendChild(option);
        });

        selectOrg.disabled = false;
    } catch (err) {
        appendTerminalLine(`Error cargando organizaciones: ${err.message}`, 'error');
    }
}

// Cargar Repositorios en la lista
async function loadRepositories() {
    reposPlaceholder.classList.add('hidden');
    reposLoader.classList.remove('hidden');
    reposList.classList.add('hidden');

    try {
        const res = await fetch('/api/repos');
        allRepos = await res.json();

        reposLoader.classList.add('hidden');
        
        if (allRepos.length === 0) {
            reposPlaceholder.innerHTML = '<p>No se encontraron repositorios propios.</p>';
            reposPlaceholder.classList.remove('hidden');
            return;
        }

        renderReposList(allRepos);
        reposList.classList.remove('hidden');
        
        // Habilitar controles del formulario
        disableControls(false);

    } catch (err) {
        reposLoader.classList.add('hidden');
        reposPlaceholder.innerHTML = `<p class="error-text">Fallo al cargar repositorios: ${err.message}</p>`;
        reposPlaceholder.classList.remove('hidden');
        appendTerminalLine(`Error cargando repositorios: ${err.message}`, 'error');
    }
}

// Renderizar la lista filtrada de repos
function renderReposList(repos) {
    reposList.innerHTML = '';

    repos.forEach(repo => {
        const isChecked = selectedRepos.has(repo.name);
        const li = document.createElement('li');
        
        li.innerHTML = `
            <label class="checkbox-container">
                <input type="checkbox" data-name="${repo.name}" ${isChecked ? 'checked' : ''}>
                <span class="checkmark"></span>
            </label>
            <div class="repo-meta">
                <div class="repo-title-row">
                    <span class="repo-name">${repo.name}</span>
                    <span class="badge ${repo.private ? 'private' : 'public'}">${repo.private ? 'Privado' : 'Público'}</span>
                </div>
                <div class="repo-desc">${repo.description}</div>
            </div>
        `;

        // Añadir evento al checkbox
        const checkbox = li.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            const repoObj = allRepos.find(r => r.name === repo.name);
            if (e.target.checked) {
                selectedRepos.add(repoObj);
            } else {
                // Eliminar por nombre o referencia
                selectedRepos.forEach(r => {
                    if (r.name === repo.name) selectedRepos.delete(r);
                });
            }
            updateSelectedCounter();
        });

        reposList.appendChild(li);
    });
}

// Filtrar la lista en pantalla
function filterRepos() {
    const query = repoSearch.value.toLowerCase();
    const filtered = allRepos.filter(repo => repo.name.toLowerCase().includes(query));
    renderReposList(filtered);
}

// Seleccionar todos los visibles tras el filtro
function selectAllFilteredRepos() {
    const query = repoSearch.value.toLowerCase();
    const filtered = allRepos.filter(repo => repo.name.toLowerCase().includes(query));
    
    filtered.forEach(repo => {
        selectedRepos.add(repo);
    });
    
    // Volver a renderizar para actualizar los checkboxes marcados
    renderReposList(filtered);
    updateSelectedCounter();
}

// Deseleccionar todos
function deselectAll() {
    selectedRepos.clear();
    const query = repoSearch.value.toLowerCase();
    const filtered = allRepos.filter(repo => repo.name.toLowerCase().includes(query));
    renderReposList(filtered);
    updateSelectedCounter();
}

// Habilitar/Deshabilitar inputs del formulario
function disableControls(disabled) {
    selectOrg.disabled = disabled;
    inputPrefix.disabled = disabled;
    repoSearch.disabled = disabled;
    btnSelectAll.disabled = disabled;
    btnDeselectAll.disabled = disabled;
    
    visibilityRadios.forEach(radio => {
        radio.disabled = disabled;
    });

    updateSelectedCounter(); // actualiza el botón de migración
}

// Actualizar contador y botón principal
function updateSelectedCounter() {
    const count = selectedRepos.size;
    selectedCounter.textContent = `${count} seleccionado${count !== 1 ? 's' : ''}`;
    
    // Habilitar botón de migración si hay selección, organización y no se está ejecutando ya
    const hasOrg = selectOrg.value !== '';
    btnStartMigration.disabled = count === 0 || !hasOrg || isMigrating;
}

// Escuchar cambios en la selección de organización para activar botón
selectOrg.addEventListener('change', updateSelectedCounter);

// Agregar líneas a la consola virtual
function appendTerminalLine(text, type = 'info') {
    const line = document.createElement('div');
    line.className = `term-line ${type}`;
    line.textContent = text;
    terminalOutput.appendChild(line);
    
    // Auto-scroll al final
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// Limpiar consola virtual
function clearTerminal() {
    terminalOutput.innerHTML = '<div class="term-line system">Consola limpiada. Listo.</div>';
}

// Iniciar la migración
async function startMigration() {
    if (selectedRepos.size === 0) return;
    const org = selectOrg.value;
    if (!org) {
        alert('Por favor selecciona una organización de destino.');
        return;
    }

    // Confirmación final
    const confirmMsg = `¿Estás seguro de que deseas copiar ${selectedRepos.size} repositorio(s) a la organización "${org}"?`;
    if (!confirm.confirm && !window.confirm(confirmMsg)) {
        return;
    }

    // Inicializar estado de carga de la migración
    isMigrating = true;
    btnStartMigration.disabled = true;
    disableFormWhileMigrating(true);

    totalToMigrate = selectedRepos.size;
    migratedCount = 0;

    // Mostrar barra de progreso
    progressWrapper.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = 'Migrando: 0%';
    progressStatus.textContent = 'Inicializando...';

    // Obtener visibilidad seleccionada
    let visibilityOption = 'keep';
    visibilityRadios.forEach(radio => {
        if (radio.checked) visibilityOption = radio.value;
    });

    const prefix = inputPrefix.value.trim();

    try {
        // Enviar orden de migración
        const response = await fetch('/api/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                org,
                prefix,
                visibilityOption,
                repos: Array.from(selectedRepos).map(r => ({ name: r.name, private: r.private }))
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Error al iniciar proceso en backend');
        }

    } catch (err) {
        appendTerminalLine(`Error al iniciar la migración: ${err.message}`, 'error');
        resetMigrationState();
    }
}

// Actualizar barra de progreso visualmente
function updateProgressBar() {
    const percent = Math.min(100, Math.round((migratedCount / totalToMigrate) * 100));
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `Migrando: ${percent}%`;
    
    if (migratedCount >= totalToMigrate) {
        progressStatus.textContent = '¡Todo listo!';
        setTimeout(() => {
            resetMigrationState();
        }, 3000);
    }
}

// Resetear estado tras completar o fallar
function resetMigrationState() {
    isMigrating = false;
    disableFormWhileMigrating(false);
    updateSelectedCounter();
}

function disableFormWhileMigrating(disabled) {
    selectOrg.disabled = disabled;
    inputPrefix.disabled = disabled;
    repoSearch.disabled = disabled;
    btnSelectAll.disabled = disabled;
    btnDeselectAll.disabled = disabled;
    patTokenInput.disabled = disabled;
    btnDisconnect.disabled = disabled;
    
    visibilityRadios.forEach(radio => {
        radio.disabled = disabled;
    });

    // Deshabilitar checkboxes en la lista
    const checkboxes = reposList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.disabled = disabled;
    });
}
