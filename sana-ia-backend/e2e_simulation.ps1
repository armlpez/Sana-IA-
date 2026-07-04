$ErrorActionPreference = 'Stop'

Write-Host "1. Autenticando..."
$LOGIN = Invoke-RestMethod -Uri "http://44.198.177.129:3000/v1/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"user@gmail.com","password":"12345678"}'
$TOKEN = $LOGIN.access_token

Write-Host "2. Iniciando chat (3 mensajes)..."
$messages = @(
    "Hola, me hice unos examenes de sangre porque me he sentido mareado.",
    "El doctor me dijo que revisara mi glucosa y colesterol.",
    "Tengo los resultados, quiero saber si estan muy altos."
)

$convId = $null

for ($i = 0; $i -lt $messages.Length; $i++) {
    $msg = $messages[$i]
    Write-Host "  -> Paciente: $msg"
    
    $body = @{ message = $msg }
    if ($convId -ne $null) { $body.conversationId = $convId }

    $RES = Invoke-RestMethod -Uri "http://44.198.177.129:3000/v1/ai/chat" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $TOKEN"} -Body ($body | ConvertTo-Json)
    if ($RES.conversationId) { $convId = $RES.conversationId }
    Write-Host "  <- Sana-IA: $($RES.message)"
}

Write-Host "3. Subiendo documento de laboratorio al OCR..."
$imagePath = "C:\Users\ajlopez\.gemini\antigravity\brain\bf2fa469-4238-4d6e-a203-fc61a3010103\medical_lab_report_1783179636922.png"
$boundary = [System.Guid]::NewGuid().ToString()
$LF = "
"
$fileBytes = [System.IO.File]::ReadAllBytes($imagePath)

$bodyLines = @(
    "--$boundary",
    "Content-Disposition: form-data; name="image"; filename="medical_lab_report.png"",
    "Content-Type: image/png",
    "",
    [System.Text.Encoding]::GetEncoding("iso-8859-1").GetString($fileBytes),
    "--$boundary",
    "Content-Disposition: form-data; name="consultationId"",
    "",
    $convId,
    "--$boundary--"
)
$bodyString = $bodyLines -join $LF
$bodyBytes = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetBytes($bodyString)

$headers = @{
    Authorization = "Bearer $TOKEN"
    "Content-Type" = "multipart/form-data; boundary=$boundary"
}

$OCR_SUBMIT = Invoke-RestMethod -Uri "http://44.198.177.129:3000/v1/ocr/analyze" -Method Post -Headers $headers -Body $bodyBytes
Write-Host "  -> Job creado: $($OCR_SUBMIT.jobId)"
$jobId = $OCR_SUBMIT.jobId

Write-Host "4. Esperando a que el OCR procese el documento (polling)..."
$ocrDone = $false
while (-not $ocrDone) {
    $JOB_STATUS = Invoke-RestMethod -Uri "http://44.198.177.129:3000/v1/ocr/jobs/$jobId" -Method Get -Headers @{Authorization="Bearer $TOKEN"}
    Write-Host "  -> Estado del OCR: $($JOB_STATUS.status)"
    if ($JOB_STATUS.status -eq "COMPLETED") {
        $ocrDone = $true
        Write-Host "  -> Biomarcadores detectados: $($JOB_STATUS.biomarkers)"
    } elseif ($JOB_STATUS.status -eq "FAILED") {
        Write-Host "  -> Error en OCR!"
        break
    } else {
        Start-Sleep -Seconds 2
    }
}

Write-Host "5. Generando Reporte Final..."
$REPORT = Invoke-RestMethod -Uri "http://44.198.177.129:3000/v1/consultations/$convId/report" -Method Get -Headers @{Authorization="Bearer $TOKEN"}
Write-Host "--- REPORTE FINAL ---"
$REPORT | ConvertTo-Json -Depth 5
