const fs = require('fs');

async function run() {
    console.log("1. Autenticando...");
    let res = await fetch("http://44.198.177.129:3000/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@gmail.com", password: "12345678" })
    });
    const auth = await res.json();
    const token = auth.access_token;

    console.log("2. Iniciando chat...");
    const messages = [
        "Hola, me hice unos examenes de sangre porque me he sentido mareado.",
        "El doctor me dijo que revisara mi glucosa y colesterol.",
        "Tengo los resultados, quiero saber si estan muy altos."
    ];
    let convId = null;

    for (const msg of messages) {
        console.log("  -> Paciente: " + msg);
        const body = { message: msg };
        if (convId) body.conversationId = convId;

        res = await fetch("http://44.198.177.129:3000/v1/ai/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
            },
            body: JSON.stringify(body)
        });
        const chatRes = await res.json();
        if (chatRes.conversationId) convId = chatRes.conversationId;
        console.log("  <- Sana-IA: " + chatRes.message);
    }

    console.log("3. Subiendo documento de laboratorio al OCR...");
    const imagePath = 'C:\\Users\\ajlopez\\.gemini\\antigravity\\brain\\bf2fa469-4238-4d6e-a203-fc61a3010103\\medical_lab_report_1783179636922.png';
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Construct manual multipart since native fetch FormData with Node buffers can be tricky without the FormData class from node-fetch
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    let data = '';
    data += '--' + boundary + '\r\n';
    data += 'Content-Disposition: form-data; name="image"; filename="report.png"\r\n';
    data += 'Content-Type: image/png\r\n\r\n';
    
    const endData = '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="consultationId"\r\n\r\n' + convId + '\r\n--' + boundary + '--\r\n';
    
    const payload = Buffer.concat([
        Buffer.from(data, 'utf8'),
        imageBuffer,
        Buffer.from(endData, 'utf8')
    ]);

    res = await fetch("http://44.198.177.129:3000/v1/ocr/analyze", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "Content-Length": payload.length
        },
        body: payload
    });
    
    const ocrRes = await res.json();
    console.log("  -> Job creado: " + ocrRes.jobId);
    const jobId = ocrRes.jobId;

    console.log("4. Esperando a que el OCR procese el documento...");
    let ocrDone = false;
    while (!ocrDone) {
        res = await fetch("http://44.198.177.129:3000/v1/ocr/jobs/" + jobId, {
            headers: { "Authorization": "Bearer " + token }
        });
        const jobStatus = await res.json();
        console.log("  -> Estado del OCR: " + jobStatus.status);
        if (jobStatus.status === "COMPLETED") {
            ocrDone = true;
            console.log("  -> Biomarcadores detectados:");
            console.log(jobStatus.biomarkers);
        } else if (jobStatus.status === "FAILED") {
            console.log("  -> Error en OCR!");
            break;
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    console.log("5. Generando Reporte Final...");
    res = await fetch("http://44.198.177.129:3000/v1/consultations/" + convId + "/report", {
        headers: { "Authorization": "Bearer " + token }
    });
    const report = await res.json();
    console.log("--- REPORTE FINAL ---");
    console.log(JSON.stringify(report, null, 2));
}

run().catch(console.error);
