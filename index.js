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
  credential: admin.credential.cert(require('./cosas.json'))
});
*/

const db = admin.firestore();
app.use(express.json());

app.get('/ping', (req, res) => {
  res.send('pong');
});

/*
Consultar la colección
*/
app.get('/verificar', async (req, res) => {
  try {
    const ventas = await obtenerVentas();
    const resultado = await procesarVentas(ventas);

    res.status(200).json({
      ok: true,
      total: ventas.length,
      sospechosas: resultado.sospechosas.length,
      inventario_no_coincide: resultado.inventarioNoCoincide.length,
      detalles_inventario_no_coincide: resultado.inventarioNoCoincide
    });

  } catch (error) {
    console.error('❌ Error general de verificación:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


// 🧪 Función para verificar y duplicar ventas sospechosas
async function procesarVentas(ventas) {
  const sospechosas = [];
  const cilindrosMap = new Map();
  const inventarioNoCoincide = [];

  // Duplicados
  for (const venta of ventas) {
    const idCilindro = venta.ID_CILINDRO;
    if (!idCilindro) continue;

    const fechaVenta = venta.FECHA_VENTA?._seconds || 0;

    if (!cilindrosMap.has(idCilindro)) {
      cilindrosMap.set(idCilindro, venta);
    } else {
      const existente = cilindrosMap.get(idCilindro);
      const fechaExistente = existente.FECHA_VENTA?._seconds || 0;

      if (fechaVenta < fechaExistente) {
        sospechosas.push(existente);
        cilindrosMap.set(idCilindro, venta);
      } else {
        sospechosas.push(venta);
      }
    }
  }

  for (const venta of cilindrosMap.values()) {
    const precio = parseFloat(venta.PRECIO);

    const camposClave = ['ID_CILINDRO', 'ID_VENDEDOR', 'FOLIO', 'PRECIO', 'DOMICILIO'];
    const tieneCamposNulos = camposClave.some(campo =>
      venta[campo] === null || venta[campo] === undefined || venta[campo] === ''
    );

    const ventaInvalida = isNaN(precio) || precio < 0 || precio > 20000;

    // ✅ Validación de inventario activada nuevamente (modo solo lectura)
    const asignacionValida = await checkAsignacionCorrecta(venta);
    const asignacionInvalida = !asignacionValida;

    if (asignacionInvalida) {
      inventarioNoCoincide.push({
        folio: venta.FOLIO,
        id_cilindro: venta.ID_CILINDRO,
        id_vendedor: venta.ID_VENDEDOR
      });
    }

    if (ventaInvalida || tieneCamposNulos) {
      sospechosas.push(venta);
    }
  }

  return { sospechosas, inventarioNoCoincide };
}

async function checkAsignacionCorrecta(venta) {
  const { ID_VENDEDOR, ID_CILINDRO } = venta;
  if (!ID_VENDEDOR || !ID_CILINDRO) return false;

  try {
    const docRef = db.collection('asignacion_diaria').doc(ID_VENDEDOR);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.warn(`📛 No existe asignación para vendedor ${ID_VENDEDOR}`);
      return false;
    }

    const data = docSnap.data();
    const productos = data.productos || {};

    // Recorrer todas las entradas del objeto productos (clave "0", "1", "2", etc.)
    for (const key in productos) {
      const producto = productos[key];
      if (!producto) continue;

      const cilindros = Object.keys(producto);
      if (cilindros.includes(ID_CILINDRO)) {
        return true; // ✅ Cilindro encontrado en su asignación
      }
    }

    console.warn(`❌ Cilindro ${ID_CILINDRO} no asignado a vendedor ${ID_VENDEDOR}`);
    return false;
  } catch (err) {
    console.error(`🔥 Error al verificar asignación de ${ID_VENDEDOR}:`, err);
    return false;
  }
}


// 🔍 Función para obtener todas las ventas
async function obtenerVentas() {
  const snapshot = await db.collection('venta_dia_sms').get();

  if (snapshot.empty) return [];

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// 🔄 Mover una venta a las colecciones sospechosas
async function moverASospechosas(venta) {
  try {
    await Promise.all([
      db.collection('venta_sospechosa').add(venta),
      db.collection('venta_dia_sospechosa_sms').add(venta)
    ]);

    console.warn(`🚨 Venta sospechosa registrada (FOLIO=${venta.FOLIO}, CILINDRO=${venta.ID_CILINDRO})`);
  } catch (err) {
    console.error('❌ Error al mover venta a sospechosas:', err);
  }
}

/*
Consultar colección
*/

app.get('/ver-asignacion/:idVendedor', async (req, res) => {
  const idVendedor = req.params.idVendedor;

  try {
    const docRef = db.collection('asignacion_diaria').doc(idVendedor);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ ok: false, mensaje: `No se encontró asignación para ${idVendedor}` });
    }

    const data = docSnap.data();

    res.status(200).json({
      ok: true,
      id: docSnap.id,
      asignacion: data
    });
  } catch (error) {
    console.error('❌ Error al obtener asignación:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});



app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});