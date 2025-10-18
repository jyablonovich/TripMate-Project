// app_code/lambdas/lambda_dbinit/index.js
const mysql = require('mysql2/promise');

exports.handler = async () => {
  try {
    const DB_HOST = process.env.DB_HOST;
    const DB_USER = process.env.DB_USER || 'admin';
    const DB_PASSWORD = process.env.DB_PASSWORD;
    const DB_NAME = process.env.DB_NAME || 'basededatostripmate2025bd';

    const admin = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD, multipleStatements:true });
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`);
    await admin.end();

    const conn = await mysql.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, multipleStatements:true });

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
    return { ok: true, msg: 'Base y tablas listas ✅' };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
};
