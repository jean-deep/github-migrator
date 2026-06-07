import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Estado en memoria
let sessionToken = '';
let sessionUsername = '';
const sseClients = [];

// Helper para sanitizar logs (ocultar token y credenciales)
function sanitize(text, token) {
  if (!text) return '';
  let clean = text;
  if (token) {
    clean = clean.split(token).join('****');
  }
  // Limpia el formato oauth2:token@
  clean = clean.replace(/oauth2:[^@]+@/g, '');
  return clean;
}

// Enviar logs en tiempo real a la interfaz
function sendLog(message, type = 'info', repo = null) {
  const data = JSON.stringify({ message: sanitize(message, sessionToken), type, repo });
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Ejecutar comandos del sistema de forma segura
function runCmd(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    sendLog(`Ejecutando: ${cmd} ${args.join(' ')}`, 'cmd');
    
    try {
      const child = spawn(cmd, args, options);
      let output = '';
      let errorOutput = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        sendLog(text, 'stdout');
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        sendLog(text, 'stderr');
      });

      child.on('error', (err) => {
        sendLog(`Fallo al iniciar proceso del sistema: ${err.message}`, 'error');
        reject(new Error(`Fallo al iniciar el comando: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Comando falló con código ${code}. Detalles: ${errorOutput}`));
        }
      });
    } catch (err) {
      sendLog(`Excepción al iniciar comando: ${err.message}`, 'error');
      reject(err);
    }
  });
}

// API: Conectar y validar token
app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token no proveído' });
  }

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-migrator-local'
      }
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({ error: errData.message || 'Token no válido' });
    }

    const data = await response.json();
    sessionToken = token;
    sessionUsername = data.login;

    res.json({
      success: true,
      username: data.login,
      avatar: data.avatar_url,
      name: data.name || data.login
    });
  } catch (error) {
    console.error('Error de conexión:', error);
    res.status(500).json({ error: 'Error interno de red al conectar con GitHub' });
  }
});

// API: Obtener organizaciones del usuario
app.get('/api/orgs', async (req, res) => {
  if (!sessionToken) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const response = await fetch('https://api.github.com/user/orgs', {
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-migrator-local'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'No se pudieron cargar las organizaciones' });
    }

    const data = await response.json();
    res.json(data.map(org => ({ login: org.login })));
  } catch (error) {
    res.status(500).json({ error: 'Error de red al cargar organizaciones' });
  }
});

// API: Obtener repositorios del usuario (paginado para obtener hasta 200)
app.get('/api/repos', async (req, res) => {
  if (!sessionToken) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    let allRepos = [];
    // Hacemos 2 llamadas para tener hasta 200 repos
    for (let page = 1; page <= 2; page++) {
      const response = await fetch(`https://api.github.com/user/repos?type=owner&per_page=100&page=${page}&sort=updated`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'github-migrator-local'
        }
      });

      if (!response.ok) {
        break;
      }

      const data = await response.json();
      if (data.length === 0) break;
      allRepos = allRepos.concat(data);
    }

    // Filtrar solo los que pertenecen al usuario (no de orgs que ya tenga)
    const personalRepos = allRepos
      .filter(repo => repo.owner.login.toLowerCase() === sessionUsername.toLowerCase())
      .map(repo => ({
        name: repo.name,
        description: repo.description || 'Sin descripción',
        private: repo.private,
        url: repo.html_url
      }));

    res.json(personalRepos);
  } catch (error) {
    res.status(500).json({ error: 'Error de red al cargar repositorios' });
  }
});

// Canal de eventos en tiempo real (Server-Sent Events)
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  sseClients.push(res);
  
  // Enviar mensaje de bienvenida
  res.write(`data: ${JSON.stringify({ message: 'Conectado a la consola del servidor local.', type: 'system' })}\n\n`);

  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

// API: Iniciar migración
app.post('/api/migrate', async (req, res) => {
  const { org, repos, prefix, visibilityOption } = req.body;

  if (!sessionToken) {
    return res.status(401).json({ error: 'No autorizado. Conecta tu token primero.' });
  }
  if (!org || !repos || repos.length === 0) {
    return res.status(400).json({ error: 'Datos de migración incompletos.' });
  }

  // Responder inmediatamente que se ha iniciado el proceso
  res.json({ success: true, message: `Iniciada migración de ${repos.length} repositorios.` });

  // Ejecutar proceso asíncrono en un bloque seguro e independiente
  (async () => {
    try {
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
      }

      sendLog(`\n🚀 INICIANDO PROCESO DE MIGRACIÓN PARA ${repos.length} REPOSITORIOS`, 'header');
      sendLog(`Organización destino: ${org}`, 'info');
      sendLog(`Prefijo: ${prefix || '(Ninguno)'}`, 'info');
      sendLog(`Visibilidad: ${visibilityOption === 'keep' ? 'Mantener original' : visibilityOption}`, 'info');

      for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        const originalName = repo.name;
        const isPrivateOriginal = repo.private;
        const destName = `${prefix || ''}${originalName}`;
        const repoGitDir = path.join(tempDir, `${originalName}.git`);

        sendLog(`\n[${i + 1}/${repos.length}] Procesando: ${originalName} ➜ ${destName}...`, 'progress', originalName);

        try {
          // 1. Crear el repositorio en la organización
          let isPrivateDest = isPrivateOriginal;
          if (visibilityOption === 'private') isPrivateDest = true;
          if (visibilityOption === 'public') isPrivateDest = false;

          sendLog(`Creando repositorio de destino en GitHub: ${org}/${destName}...`, 'info', originalName);
          
          const createResponse = await fetch(`https://api.github.com/orgs/${org}/repos`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${sessionToken}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'Content-Type': 'application/json',
              'User-Agent': 'github-migrator-local'
            },
            body: JSON.stringify({
              name: destName,
              private: isPrivateDest,
              description: `Migrado de ${sessionUsername}/${originalName}`
            })
          });

          if (!createResponse.ok) {
            const createErr = await createResponse.json().catch(() => ({ message: createResponse.statusText }));
            // Si el error es que ya existe, podemos continuar y hacer push para actualizarlo
            if (createErr.message && createErr.message.includes('already exists')) {
              sendLog(`⚠️ El repositorio ${org}/${destName} ya existe en la organización. Se procederá a actualizar su contenido.`, 'warn', originalName);
            } else {
              throw new Error(`No se pudo crear el repositorio en GitHub: ${createErr.message || createResponse.statusText}`);
            }
          } else {
            sendLog(`✅ Repositorio ${org}/${destName} creado con éxito.`, 'success', originalName);
          }

          // 2. Clonar en modo bare
          const originUrl = `https://oauth2:${sessionToken}@github.com/${sessionUsername}/${originalName}.git`;
          sendLog(`Clonando en modo bare...`, 'info', originalName);
          await runCmd('git', ['clone', '--bare', originUrl, repoGitDir]);

          // 3. Subir mirror
          const destUrl = `https://oauth2:${sessionToken}@github.com/${org}/${destName}.git`;
          sendLog(`Subiendo espejo (mirror) a la organización...`, 'info', originalName);
          await runCmd('git', ['push', '--mirror', destUrl], { cwd: repoGitDir });

          // 4. Limpiar localmente
          sendLog(`Limpiando carpeta temporal...`, 'info', originalName);
          if (fs.existsSync(repoGitDir)) {
            fs.rmSync(repoGitDir, { recursive: true, force: true });
          }

          sendLog(`🎉 ¡Migración de ${originalName} completada con éxito!`, 'done', originalName);

        } catch (err) {
          sendLog(`❌ Error al migrar ${originalName}: ${err.message}`, 'error', originalName);
          
          // Limpiar carpeta temporal si falló a la mitad
          if (fs.existsSync(repoGitDir)) {
            try {
              fs.rmSync(repoGitDir, { recursive: true, force: true });
            } catch (rmErr) {
              // ignorar error de limpieza
            }
          }
        }
      }

      sendLog(`\n🏁 MIGRACIÓN FINALIZADA.`, 'header');
    } catch (criticalErr) {
      console.error('Error crítico en migración en segundo plano:', criticalErr);
      sendLog(`❌ Error crítico en el servidor al migrar: ${criticalErr.message}`, 'error');
    }
  })();
});

// Limpieza al cerrar la aplicación
process.on('SIGINT', () => {
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {}
  }
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Servidor local corriendo en http://localhost:${PORT}`);
});
