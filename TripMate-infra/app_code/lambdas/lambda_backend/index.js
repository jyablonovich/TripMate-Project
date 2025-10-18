// app_code/lambdas/lambda_backend/index.js

// ===== Dependencias =====
const mysql = require('mysql2/promise');
const {
  SNSClient,
  PublishCommand,
  CreateTopicCommand,
  SubscribeCommand,
} = require('@aws-sdk/client-sns');

const sns = new SNSClient({});

// ===== SNS por viaje =====
const TOPIC_PREFIX = process.env.TOPIC_PREFIX || 'tripmate-viaje-';

async function getOrCreateTripTopicArn(viajeId) {
  const name = `${TOPIC_PREFIX}${viajeId}`;           
  const out = await sns.send(new CreateTopicCommand({ 
    Name: name
  }));
  return out.TopicArn;
}

async function subscribeEmailToTrip(viajeId, email) {
  const arn = await getOrCreateTripTopicArn(viajeId);
  // SNS (email) envía un mail de confirmación la primera vez
  await sns.send(new SubscribeCommand({
    TopicArn: arn,
    Protocol: 'email',
    Endpoint: email,
  }));
  return arn;
}

async function publishTrip(viajeId, subject, message) {
  const arn = await getOrCreateTripTopicArn(viajeId);
  await sns.send(new PublishCommand({
    TopicArn: arn,
    Subject: subject,
    Message: message,
  }));
}

// ===== Helpers: email del usuario =====
function base64UrlDecode(str = '') {
  try {
    const pad = (4 - (str.length % 4)) % 4;
    const b64 = (str + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch { return ''; }
}

function getEmailFromEvent(event) {
  const claims =
    event?.requestContext?.authorizer?.claims ||
    event?.requestContext?.authorizer?.jwt?.claims || {};
  if (claims?.email) return String(claims.email);
  if (claims['cognito:username']) return String(claims['cognito:username']);

  const auth = event?.headers?.Authorization || event?.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token) {
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(base64UrlDecode(parts[1]) || '{}');
        return payload.email || payload['cognito:username'] || null;
      } catch {}
    }
  }
  return null;
}

// ===== Utilitarios =====
function corsHeaders() {
  const origin = process.env.CORS_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
  };
}
function send(status, body) { return { statusCode: status, headers: corsHeaders(), body: JSON.stringify(body) }; }
const ok          = (b) => send(200, b);
const bad         = (b) => send(400, b);
const unauthorized= (b) => send(401, b);
const notfound    = (b) => send(404, b);
const fail        = (e) => { console.error(e); return send(500, { ok:false, error:String(e?.message||e||'server_error') }); };

// ===== Auto-init + Migración compatible =====
let schemaReady = false;

async function columnExists(conn, dbName, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [dbName, table, column]
  );
  return rows.length > 0;
}

async function ensureSchema() {
  if (schemaReady) return;

  const DB_HOST = process.env.DB_HOST;
  const DB_USER = process.env.DB_USER;
  const DB_PASSWORD = process.env.DB_PASSWORD;
  const DB_NAME = process.env.DB_NAME || 'basededatostripmate2025bd';

  // 1) crear DB si no existe
  const admin = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASSWORD, multipleStatements:true
  });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
  await admin.end();

  // 2) crear tablas y migrar si hace falta
  const conn = await mysql.createConnection({
    host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, multipleStatements:true
  });

  await conn.query(`
    CREATE TABLE IF NOT EXISTS viajes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_sub VARCHAR(255) NULL,
      user_email VARCHAR(255) NULL,
      nombre VARCHAR(255) NOT NULL,
      access_code VARCHAR(12) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_viajes_code (access_code)
    ) ENGINE=InnoDB;
  `);

  // Migraciones defensivas
  if (!(await columnExists(conn, DB_NAME, 'viajes', 'user_email'))) {
    await conn.query(`ALTER TABLE viajes ADD COLUMN user_email VARCHAR(255) NULL;`);
  }
  if (!(await columnExists(conn, DB_NAME, 'viajes', 'access_code'))) {
    await conn.query(`ALTER TABLE viajes ADD COLUMN access_code VARCHAR(12) NULL;`);
    await conn.query(`ALTER TABLE viajes ADD UNIQUE KEY uk_viajes_code (access_code);`);
  } else {
    try { await conn.query(`ALTER TABLE viajes ADD UNIQUE KEY uk_viajes_code (access_code);`); } catch(_) {}
  }
  try {
    const [cols] = await conn.query(
      `SELECT CHARACTER_MAXIMUM_LENGTH as len
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME='viajes' AND COLUMN_NAME='nombre'`,
      [DB_NAME]
    );
    const len = cols?.[0]?.len;
    if (len && Number(len) < 255) {
      await conn.query(`ALTER TABLE viajes MODIFY COLUMN nombre VARCHAR(255) NOT NULL;`);
    }
  } catch {}

  await conn.query(`
    CREATE TABLE IF NOT EXISTS actividades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      viaje_id INT NOT NULL,
      nombre VARCHAR(255) NOT NULL,
      precio DECIMAL(10,2) NOT NULL DEFAULT 0,
      created_by_email VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_actividades_viaje FOREIGN KEY (viaje_id) REFERENCES viajes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS actividad_votos (
      actividad_id INT NOT NULL,
      user_email   VARCHAR(255) NOT NULL,
      voto         TINYINT(1) NOT NULL,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (actividad_id, user_email),
      CONSTRAINT fk_votos_actividad FOREIGN KEY (actividad_id) REFERENCES actividades(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS viaje_miembros (
      viaje_id   INT NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      joined_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (viaje_id, user_email),
      CONSTRAINT fk_miembros_viaje FOREIGN KEY (viaje_id) REFERENCES viajes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `);

  await conn.end();
  schemaReady = true;
}

async function getConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'basededatostripmate2025bd',
    connectTimeout: 5000, // arranque en frío tolerante
  });
}

function genCode(n=6){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/I/1
  let s=''; for (let i=0;i<n;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

// ===== Handler =====
exports.handler = async (event) => {
  try {
    const method = (event?.requestContext?.http?.method || event?.httpMethod || '').toUpperCase();
    const path = (event?.requestContext?.http?.path || event?.rawPath || event?.path || event?.resource || '')
      .toLowerCase()
      .replace(/\/+$/,'');

    if (method === 'OPTIONS') return send(200, { ok:true });

    // Garantiza DB/Tablas
    await ensureSchema();

    // Diagnóstico
    if (method==='GET' && path.endsWith('/ping'))    return ok({ ok:true, time:new Date().toISOString() });
    if (method==='GET' && path.endsWith('/dbcheck')) {
      try {
        const conn = await getConn();
        const [[r]] = await conn.query('SELECT 1 AS ok');
        await conn.end();
        return ok({ ok: r?.ok === 1 });
      } catch (e) { return fail(e); }
    }

    // ----- VIAJES -----
    if (method==='GET' && path.endsWith('/listar')) {
      const email = getEmailFromEvent(event) || null;
      const conn = await getConn();
      const [rows] = await conn.execute(`
        SELECT v.id, v.nombre, v.access_code,
               COALESCE(v.user_email, v.user_sub) AS owner,
               v.created_at
          FROM viajes v
         WHERE
           (v.user_email = ? OR (? IS NULL AND v.user_email IS NULL))
           OR (v.user_sub = ? AND (v.user_email IS NULL))
           OR EXISTS (SELECT 1 FROM viaje_miembros m WHERE m.viaje_id = v.id AND m.user_email = ?)
         ORDER BY v.id DESC
      `, [email, email, email, email]);
      await conn.end();
      return ok(rows);
    }

    if (method==='POST' && path.endsWith('/guardar')) {
      let body={};
      try { body = typeof event.body === 'string' ? JSON.parse(event.body||'{}') : (event.body||{}); }
      catch { return bad({ ok:false, error:'JSON inválido' }); }

      // 🗑️ Borrar viaje
      if (body.delete_viaje) {
        const viajeId = Number(body.delete_viaje);
        if (!Number.isInteger(viajeId) || viajeId <= 0) return bad({ ok:false, error:'viaje id inválido' });

        const email = getEmailFromEvent(event) || null;
        const conn = await getConn();

        // (opcional) solo owner puede borrar
        const [[v]] = await conn.query(
          `SELECT id, user_email, user_sub FROM viajes WHERE id=?`,
          [viajeId]
        );
        if (!v) { await conn.end(); return notfound({ ok:false, error:'viaje no encontrado' }); }
        if (email && (v.user_email === email || v.user_sub === email)) {
          await conn.query(`DELETE FROM viajes WHERE id=?`, [viajeId]);
          await conn.end();
          return ok({ ok:true, deleted: viajeId });
        } else {
          await conn.end();
          return unauthorized({ ok:false, error:'no sos owner del viaje' });
        }
      }

      // ✍️ Crear viaje
      const nombre = String(body?.nombre||'').trim();
      if (!nombre) return bad({ ok:false, error:'nombre requerido' });
      const email = getEmailFromEvent(event) || null;

      const conn = await getConn();
      let code;
      for (let i=0; i<6; i++) {
        code = genCode(6);
        try {
          const [r] = await conn.execute(
            `INSERT INTO viajes (nombre, user_email, user_sub, access_code) VALUES (?,?,?,?)`,
            [nombre, email, email, code]
          );

          // (opcional) publicación global si tenés SNS_TOPIC legacy
          const legacyTopic = process.env.SNS_TOPIC || process.env.SNSTOPIC;
          if (legacyTopic) {
            try {
              await sns.send(new PublishCommand({
                TopicArn: legacyTopic,
                Message: `Nuevo viaje: ${nombre} (usuario=${email||'anon'})`
              }));
            } catch(e){ console.warn('SNS publish failed:', e?.message); }
          }

          await conn.end();
          return ok({ ok:true, id:r.insertId, access_code: code });
        } catch (e) {
          // si violó unique del código, reintenta; si es otro error, falla
          if (!String(e?.message||'').includes('Duplicate')) { await conn.end(); return fail(e); }
        }
      }
      await conn.end();
      return fail(new Error('No se pudo generar código único'));
    }

    // ----- UNIRSE A VIAJE -----
    if (method==='POST' && path.endsWith('/unirse')) {
      let body={};
      try { body = typeof event.body === 'string' ? JSON.parse(event.body||'{}') : (event.body||{}); }
      catch { return bad({ ok:false, error:'JSON inválido' }); }

      const codigo = String(body?.codigo||'').trim().toUpperCase();
      if (!codigo) return bad({ ok:false, error:'codigo requerido' });

      const email = getEmailFromEvent(event);
      if (!email) return unauthorized({ ok:false, error:'login requerido para unirse' });

      const conn = await getConn();
      const [[viaje]] = await conn.query(`SELECT id, nombre FROM viajes WHERE access_code = ?`, [codigo]);
      if (!viaje) { await conn.end(); return notfound({ ok:false, error:'codigo inválido' }); }

      await conn.query(`
        INSERT INTO viaje_miembros (viaje_id, user_email)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE joined_at = joined_at
      `, [viaje.id, email]);
      await conn.end();

      // Suscribe el email del usuario al tópico del viaje (requiere confirmar 1 vez por email)
      try { await subscribeEmailToTrip(viaje.id, email); }
      catch (e) { console.warn('subscribeEmailToTrip failed:', e?.message); }

      return ok({ ok:true, viaje_id: viaje.id, nombre: viaje.nombre });
    }

    // ----- ACTIVIDADES -----
    // Rutas: GET/POST /viajes/{id}/actividades
    const mAct = path.match(/\/viajes\/(\d+)\/actividades$/);
    if (mAct) {
      const viajeId = parseInt(mAct[1], 10);
      const conn = await getConn();

      if (method==='GET') {
        const [rows] = await conn.query(`
          SELECT a.id, a.viaje_id, a.nombre, a.precio, a.created_by_email, a.created_at,
                 IFNULL(SUM(CASE WHEN v.voto=1 THEN 1 ELSE 0 END),0) AS votos_favor,
                 IFNULL(SUM(CASE WHEN v.voto=0 THEN 1 ELSE 0 END),0) AS votos_contra,
                 COUNT(v.user_email) AS total_votos
            FROM actividades a
            LEFT JOIN actividad_votos v ON v.actividad_id = a.id
           WHERE a.viaje_id = ?
           GROUP BY a.id
           ORDER BY a.id DESC
        `, [viajeId]);

        const [voters] = await conn.query(`
          SELECT actividad_id, user_email, voto, updated_at, created_at
            FROM actividad_votos
           WHERE actividad_id IN (SELECT id FROM actividades WHERE viaje_id = ?)
        `, [viajeId]);

        await conn.end();
        return ok({ actividades: rows, votos: voters });
      }

      if (method==='POST') {
        let body={};
        try{ body = typeof event.body === 'string' ? JSON.parse(event.body||'{}') : (event.body||{}); }
        catch { await conn.end(); return bad({ ok:false, error:'JSON inválido' }); }

        // 🗑️ Borrar actividad
        if (body.delete_id) {
          const actId = Number(body.delete_id);
          if (!Number.isInteger(actId) || actId <= 0) { await conn.end(); return bad({ ok:false, error:'actividad id inválido' }); }
          await conn.execute(`DELETE FROM actividades WHERE id=? AND viaje_id=?`, [actId, viajeId]);
          await conn.end();
          return ok({ ok:true, deleted: actId });
        }

        // ✍️ Crear actividad (SNS antes de cerrar conexión)
        const nombre = String(body?.nombre||'').trim();
        const precio = Number(body?.precio||0);
        if (!nombre) { await conn.end(); return bad({ ok:false, error:'nombre requerido' }); }
        if (!(Number.isFinite(precio) && precio >= 0)) { await conn.end(); return bad({ ok:false, error:'precio inválido' }); }

        const email = getEmailFromEvent(event) || null;
        const [r] = await conn.execute(
          `INSERT INTO actividades (viaje_id, nombre, precio, created_by_email) VALUES (?,?,?,?)`,
          [viajeId, nombre, precio, email]
        );

        try {
          await publishTrip(
            viajeId,
            'Nueva actividad',
            `Se creó una nueva actividad en tu viaje:
- Actividad: ${nombre}
- Precio: ${precio}
- Creado por: ${email || 'anónimo'}`
          );
        } catch (e) {
          console.warn('publishTrip (actividad) failed:', e?.message);
        }

        await conn.end();
        return ok({ ok:true, id:r.insertId });
      }
    }

    // ----- VOTAR -----
    // POST /viajes/{id}/actividades/{actId}/votar
    const mVote = path.match(/\/viajes\/(\d+)\/actividades\/(\d+)\/votar$/);
    if (mVote && method==='POST') {
      const viajeId = parseInt(mVote[1], 10);
      const actId = parseInt(mVote[2], 10);

      let body={}; try{ body = typeof event.body === 'string' ? JSON.parse(event.body||'{}') : (event.body||{}); }
      catch { return bad({ ok:false, error:'JSON inválido' }); }

      const voto = Number(body?.voto);
      if (!(voto===0 || voto===1)) return bad({ ok:false, error:'voto debe ser 1 o 0' });
      const email = getEmailFromEvent(event) || 'anon';

      const conn = await getConn();

      const [[act]] = await conn.execute(`SELECT id, viaje_id, nombre FROM actividades WHERE id=?`, [actId]);
      if (!act) { await conn.end(); return notfound({ ok:false, error:'actividad no encontrada' }); }

      await conn.execute(`
        INSERT INTO actividad_votos (actividad_id, user_email, voto)
        VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE voto=VALUES(voto), updated_at=CURRENT_TIMESTAMP
      `, [actId, email, voto]);

      const [[c]] = await conn.query(`
        SELECT
          IFNULL(SUM(CASE WHEN voto=1 THEN 1 ELSE 0 END),0) AS votos_favor,
          IFNULL(SUM(CASE WHEN voto=0 THEN 1 ELSE 0 END),0) AS votos_contra,
          COUNT(*) AS total_votos
        FROM actividad_votos
        WHERE actividad_id=?
      `, [actId]);

      await conn.end();

      // Notificar voto (sin mostrar números de viaje/actividad al usuario del mail)
      try {
        await publishTrip(
          viajeId,
          'Nuevo voto',
          `Hay un nuevo voto en una actividad de tu viaje:
- Actividad: ${act.nombre}
- Resultado actual: 👍=${c.votos_favor} / 👎=${c.votos_contra}`
        );
      } catch (e) {
        console.warn('publishTrip (voto) failed:', e?.message);
      }

      return ok({ ok:true, actividad_id: actId, ...c });
    }

    return notfound({ ok:false, error:'Ruta no encontrada' });

  } catch (e) {
    return fail(e);
  }
};
