const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
// Puerto
const PORT = process.env.PORT || 3000;
const firebaseBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;

if (!firebaseBase64) {
  throw new Error('FIREBASE_CREDENTIALS_BASE64 no está definida');
}


const serviceAccount = JSON.parse(
  Buffer.from(firebaseBase64, 'base64').toString('utf-8')
);


admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/*
admin.initializeApp({
  credential: admin.credential.cert(require('./autolog-13584-firebase-adminsdk-lic3j-bc9d0d95eb.json'))
});
*/
const db = admin.firestore();
app.use(express.json());

app.get('/ping', (req, res) => {
  res.send('pong');
});


app.use((req, res, next) => {
  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const timeInMs = (diff[0] * 1e3 + diff[1] / 1e6).toFixed(2);

    const method = req.method.padEnd(6);
    const url = req.originalUrl.padEnd(50);
    const maxLength = 80;
    const dotsCount = Math.max(0, maxLength - method.length - url.length);
    const dots = '.'.repeat(dotsCount);

    console.log(`${method} ${url}${dots} ${res.statusCode} [${timeInMs} ms]`);
  });

  next();
});

app.use(express.json()); // Asegura que puedes recibir JSON en el body


function parsearVenta(texto) {
  const partes = texto.split(';');
  const result = {};

  partes.forEach(p => {
    const [clave, valor] = p.split(':');
    if (clave && valor) {
      result[clave.trim().toUpperCase()] = valor.trim();
    }
  });

  return {
    IDCILINDRO: result.IDCILINDRO || null,
    IDVENDEDOR: result.IDVENDEDOR || null
  };
}

function extraerProductos(productosMap) {
  const productos = [];
  if (typeof productosMap === 'object' && productosMap !== null) {
    for (const key of Object.keys(productosMap)) {
      const entrada = productosMap[key];
      if (typeof entrada === 'object' && entrada !== null) {
        const idCilindro = Object.keys(entrada)[0];
        const datos = entrada[idCilindro];
        productos.push({ idCilindro, datos });
      }
    }
  }
  return productos;
}

function reconstruirProductosMap(productos) {
  const map = {};
  productos.forEach((p, i) => {
    map[i] = {
      [p.idCilindro]: p.datos
    };
  });
  return map;
}
/*
Esta función genera reportes
*/
app.post('/validar-informacion', async (req, res) => {
  try {
    const body = req.body.data || '';
    const ventas = body.split('|').map(v => v.trim()).filter(v => v);
    const resultados = [];

    for (const venta of ventas) {
      const parsed = parsearVenta(venta);
      const { IDCILINDRO, IDVENDEDOR } = parsed;

      if (!IDCILINDRO || !IDVENDEDOR) {
        resultados.push({ id_cilindro: IDCILINDRO || 'N/A', id_vendedor: IDVENDEDOR || 'N/A', estado: false });
        continue;
      }

      const asignacionDocRef = db.collection('asignacion_diaria').doc(IDVENDEDOR);
      const asignacionDoc = await asignacionDocRef.get();

      if (!asignacionDoc.exists) {

        const exito = await buscarYValidarDocumento(IDVENDEDOR, IDCILINDRO, resultados);

        if (!exito) {
          resultados.push({ id_cilindro: IDCILINDRO, id_vendedor: IDVENDEDOR, estado: false });
        }
        continue;
      }


      const productosMap = asignacionDoc.data().productos || {};
      const productos = extraerProductos(productosMap);

      const index = productos.findIndex(p => p.idCilindro === IDCILINDRO);

      if (index === -1) {
        const exito = await buscarYValidarDocumento(IDVENDEDOR, IDCILINDRO, resultados);
        if (!exito) {
          resultados.push({ id_cilindro: IDCILINDRO, id_vendedor: IDVENDEDOR, estado: false });
        }
        continue;
      }

      const cilindroData = productos[index].datos;

      if (cilindroData.estado_venta !== 'asignado') {
        resultados.push({ id_cilindro: IDCILINDRO, id_vendedor: IDVENDEDOR, estado: false });
        continue;
      }

      const historialRef = db.collection('asignacion').doc(IDVENDEDOR);
      const historialDoc = await historialRef.get();
      let historialData = historialDoc.exists ? historialDoc.data() : {};
      if (!Array.isArray(historialData.productos)) {
        historialData.productos = [];
      }

      const nuevoProducto = {
        [IDCILINDRO]: {
          ...cilindroData,
          estado_venta: 'vendido',
          fecha_venta: new Date().toISOString()
        }
      };

      historialData.productos.push(nuevoProducto);
      await historialRef.set({ productos: historialData.productos }, { merge: true });

      productos.splice(index, 1);
      const nuevoProductosMap = reconstruirProductosMap(productos);
      await asignacionDocRef.update({ productos: nuevoProductosMap });

      resultados.push({ id_cilindro: IDCILINDRO, id_vendedor: IDVENDEDOR, estado: true });
    }

    res.json(resultados);
  } catch (error) {
    console.error('Error al procesar ventas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

async function buscarYValidarDocumento(IDVENDEDOR, IDCILINDRO, resultados) {

  const snapshot = await db.collection('asignacion_diaria')
    .where('id_vendedor', '==', IDVENDEDOR)
    .get();


  if (snapshot.empty) {
    return false;
  }

  for (const docSnap of snapshot.docs) {
    const docRef = docSnap.ref;
    const productosMap = docSnap.data().productos || {};
    const productos = extraerProductos(productosMap);

    const index = productos.findIndex(
      p => p.idCilindro.trim() === IDCILINDRO.trim()
    );
    if (index === -1) {
      console.log(`⚠️ El cilindro "${IDCILINDRO}" NO se encontró en este documento (${docRef.id})`);
      continue;
    }

    const cilindroData = productos[index].datos;

    if (cilindroData.estado_venta !== 'asignado') {
      console.log(`⚠️ El cilindro "${IDCILINDRO}" se encontró pero no está asignado. Estado actual: ${cilindroData.estado_venta}`);
      continue;
    }

    // Actualizar historial
    const historialRef = db.collection('asignacion').doc(IDVENDEDOR);
    const historialDoc = await historialRef.get();
    let historialData = historialDoc.exists ? historialDoc.data() : {};
    if (!Array.isArray(historialData.productos)) {
      historialData.productos = [];
    }

    const nuevoProducto = {
      [IDCILINDRO]: {
        ...cilindroData,
        estado_venta: 'vendido',
        fecha_venta: new Date().toISOString()
      }
    };

    historialData.productos.push(nuevoProducto);
    await historialRef.set({ productos: historialData.productos }, { merge: true });

    // Actualizar asignacion_diaria
    productos.splice(index, 1);
    const nuevoProductosMap = reconstruirProductosMap(productos);
    await docRef.update({ productos: nuevoProductosMap });

    resultados.push({ id_cilindro: IDCILINDRO, id_vendedor: IDVENDEDOR, estado: true });
    console.log(`✅ Cilindro "${IDCILINDRO}" validado y actualizado correctamente en documento: ${docRef.id}`);

    return true;
  }

  console.log(`❌ Ninguno de los documentos contenía el cilindro "${IDCILINDRO}" en estado válido`);
  return false;
}




app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});