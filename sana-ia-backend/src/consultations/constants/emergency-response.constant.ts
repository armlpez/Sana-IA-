/**
 * Fixed, verbatim safety message shown when SANA detects a medical emergency —
 * either from conversational red-flag symptoms (chat) or critical lab values
 * (OCR). This text is NEVER LLM-generated: safety-critical wording must be
 * exact and non-negotiable, approved by the product owner (Eduardo Daka).
 *
 * Any consultation that emits this message is latched via
 * `consultation.emergencyDetected` and stops accepting further chat messages
 * (see ChatService.sendMessage).
 */
export const EMERGENCY_RESPONSE_MESSAGE = `SANA ha detectado valores en los datos ingresados que representan un riesgo crítico y urgente para su salud. Por su seguridad, el análisis automatizado de historial ha sido suspendido.

Por favor, siga estas instrucciones de inmediato:

No espere: Diríjase de forma inmediata a la sala de emergencias del hospital o clínica más cercana.

Comuníquese ya: Contacte a su servicio de ambulancias local o a un familiar cercano que pueda asistirlo en su traslado.

Muestre sus exámenes: Al llegar al centro médico, entregue de inmediato el documento original de laboratorio que intentaba cargar en la aplicación al personal de guardia.

Nota de seguridad: SANA es un sistema de orientación preventiva y no puede tratar ni diagnosticar emergencias médicas. Su vida es lo primero, busque ayuda profesional ahora mismo.`;
