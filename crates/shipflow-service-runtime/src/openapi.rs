use serde_json::{json, Value};

use crate::{
    api_contract::REQUEST_ID_HEADER_NAME,
    jobs::{MAX_BATCH_SHIPMENT_IDS, MAX_BATCH_SHIPMENT_ID_LENGTH},
    FORCE_REFRESH_HEADER_NAME,
};

pub const OPENAPI_SCHEMA_VERSION: &str = "shipflow.service.openapi.v1";

pub fn service_openapi_document(port: u16, lan_enabled: bool) -> Value {
    let mut servers = vec![
        json!({
            "url": format!("http://127.0.0.1:{port}"),
            "description": "Local ShipFlow Service endpoint used by ShipFlow Desktop"
        }),
        json!({
            "url": format!("http://localhost:{port}"),
            "description": "Localhost alias for ShipFlow Service"
        }),
    ];

    if lan_enabled {
        servers.push(json!({
            "url": format!("http://{{serviceHost}}:{port}"),
            "description": "LAN endpoint. Replace serviceHost with the host/IP running ShipFlow Service.",
            "variables": {
                "serviceHost": {
                    "default": "192.168.1.10",
                    "description": "Host or LAN IP address of the machine running ShipFlow Service"
                }
            }
        }));
    }

    let mut document = json!({
        "openapi": "3.1.0",
        "info": {
            "title": "ShipFlow Service API",
            "version": "v1",
            "description": "Authenticated local/LAN API for ShipFlow Desktop and trusted internal clients."
        },
        "servers": servers,
        "security": [{ "bearerAuth": [] }],
        "paths": {
            "/v1/openapi.json": {
                "get": {
                    "summary": "Read the ShipFlow Service OpenAPI document",
                    "operationId": "getOpenApiDocument",
                    "tags": ["Discovery"],
                    "responses": {
                        "200": {
                            "description": "OpenAPI 3.1 document for the current service endpoint",
                            "content": {
                                "application/json": {
                                    "schema": { "type": "object" }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" }
                    }
                }
            },
            "/v1/status": {
                "get": {
                    "summary": "Check service status and product identity",
                    "operationId": "getStatus",
                    "tags": ["Discovery"],
                    "parameters": [{ "$ref": "#/components/parameters/RequestId" }],
                    "responses": {
                        "200": {
                            "description": "Service status",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/Status" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" }
                    }
                }
            },
            "/v1/capabilities": {
                "get": {
                    "summary": "List API capabilities and available routes",
                    "operationId": "getCapabilities",
                    "tags": ["Discovery"],
                    "parameters": [{ "$ref": "#/components/parameters/RequestId" }],
                    "responses": {
                        "200": {
                            "description": "Service capabilities",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/Capabilities" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" }
                    }
                }
            },
            "/v1/track/{shipmentId}": {
                "get": {
                    "summary": "Track one shipment ID",
                    "operationId": "trackShipment",
                    "tags": ["Lookup"],
                    "parameters": [
                        { "$ref": "#/components/parameters/ShipmentId" },
                        { "$ref": "#/components/parameters/RequestId" },
                        { "$ref": "#/components/parameters/ForceRefresh" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Shipment tracking detail",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/TrackResponse" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "400": { "$ref": "#/components/responses/BadRequest" },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" },
                        "502": { "$ref": "#/components/responses/BadGateway" }
                    }
                }
            },
            "/v1/bag/{bagId}": {
                "get": {
                    "summary": "Read bag contents",
                    "operationId": "getBag",
                    "tags": ["Lookup"],
                    "parameters": [
                        { "$ref": "#/components/parameters/BagId" },
                        { "$ref": "#/components/parameters/RequestId" },
                        { "$ref": "#/components/parameters/ForceRefresh" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Bag lookup result",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/BagResponse" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "400": { "$ref": "#/components/responses/BadRequest" },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" },
                        "502": { "$ref": "#/components/responses/BadGateway" }
                    }
                }
            },
            "/v1/manifest/{manifestId}": {
                "get": {
                    "summary": "Read manifest contents",
                    "operationId": "getManifest",
                    "tags": ["Lookup"],
                    "parameters": [
                        { "$ref": "#/components/parameters/ManifestId" },
                        { "$ref": "#/components/parameters/RequestId" },
                        { "$ref": "#/components/parameters/ForceRefresh" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Manifest lookup result",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/ManifestResponse" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "400": { "$ref": "#/components/responses/BadRequest" },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" },
                        "502": { "$ref": "#/components/responses/BadGateway" }
                    }
                }
            },
            "/v1/jobs/track-batch": {
                "post": {
                    "summary": "Start a background batch tracking job",
                    "operationId": "startTrackBatchJob",
                    "tags": ["Batch Jobs"],
                    "parameters": [{ "$ref": "#/components/parameters/RequestId" }],
                    "requestBody": {
                        "required": true,
                        "content": {
                            "application/json": {
                                "schema": { "$ref": "#/components/schemas/BatchTrackRequest" }
                            }
                        }
                    },
                    "responses": {
                        "200": {
                            "description": "Queued batch job",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/BatchTrackJobStart" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "400": { "$ref": "#/components/responses/BadRequest" },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "413": { "$ref": "#/components/responses/PayloadTooLarge" },
                        "429": { "$ref": "#/components/responses/TooManyRequests" }
                    }
                }
            },
            "/v1/jobs/{jobId}": {
                "get": {
                    "summary": "Read batch job status",
                    "operationId": "getBatchJobStatus",
                    "tags": ["Batch Jobs"],
                    "parameters": [
                        { "$ref": "#/components/parameters/JobId" },
                        { "$ref": "#/components/parameters/RequestId" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Batch job status",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/BatchJobSnapshot" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" }
                    }
                }
            },
            "/v1/jobs/{jobId}/result": {
                "get": {
                    "summary": "Read batch job results",
                    "operationId": "getBatchJobResult",
                    "tags": ["Batch Jobs"],
                    "parameters": [
                        { "$ref": "#/components/parameters/JobId" },
                        { "$ref": "#/components/parameters/RequestId" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Batch job result",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/BatchJobResultSnapshot" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" }
                    }
                }
            },
            "/v1/jobs/{jobId}/cancel": {
                "post": {
                    "summary": "Cancel a running batch job",
                    "operationId": "cancelBatchJob",
                    "tags": ["Batch Jobs"],
                    "parameters": [
                        { "$ref": "#/components/parameters/JobId" },
                        { "$ref": "#/components/parameters/RequestId" }
                    ],
                    "responses": {
                        "200": {
                            "description": "Batch job status after cancellation request",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/BatchJobSnapshot" }
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        },
                        "401": { "$ref": "#/components/responses/Unauthorized" },
                        "404": { "$ref": "#/components/responses/NotFound" }
                    }
                }
            }
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "ShipFlow Service token from the Service settings window."
                }
            },
            "parameters": {
                "RequestId": {
                    "name": REQUEST_ID_HEADER_NAME,
                    "in": "header",
                    "required": false,
                    "schema": { "type": "string" },
                    "description": "Optional client-provided request id echoed in response meta.requestId."
                },
                "ForceRefresh": {
                    "name": FORCE_REFRESH_HEADER_NAME,
                    "in": "header",
                    "required": false,
                    "schema": { "type": "boolean" },
                    "description": "Set to true to bypass the service lookup cache."
                },
                "ShipmentId": {
                    "name": "shipmentId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string", "maxLength": MAX_BATCH_SHIPMENT_ID_LENGTH }
                },
                "BagId": {
                    "name": "bagId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string", "maxLength": MAX_BATCH_SHIPMENT_ID_LENGTH }
                },
                "ManifestId": {
                    "name": "manifestId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string", "maxLength": MAX_BATCH_SHIPMENT_ID_LENGTH }
                },
                "JobId": {
                    "name": "jobId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string" }
                }
            },
            "responses": {
                "BadRequest": {
                    "description": "Invalid input",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "Unauthorized": {
                    "description": "Missing or invalid bearer token",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "NotFound": {
                    "description": "Resource was not found",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "BadGateway": {
                    "description": "Upstream tracking source failed",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "PayloadTooLarge": {
                    "description": "Batch request is too large",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "TooManyRequests": {
                    "description": "Too many active batch jobs",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                }
            },
            "schemas": {
                "Meta": {
                    "type": "object",
                    "required": ["apiVersion", "schemaVersion", "requestId", "generatedAt"],
                    "properties": {
                        "apiVersion": { "type": "string", "const": "v1" },
                        "schemaVersion": { "type": "string" },
                        "requestId": { "type": "string" },
                        "generatedAt": { "type": "string", "format": "date-time" }
                    }
                },
                "EnvelopeBase": {
                    "type": "object",
                    "required": ["meta", "warnings"],
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/Meta" },
                        "warnings": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                },
                "ErrorEnvelope": {
                    "type": "object",
                    "required": ["meta", "error", "warnings"],
                    "properties": {
                        "meta": { "$ref": "#/components/schemas/Meta" },
                        "error": {
                            "type": "object",
                            "required": ["message"],
                            "properties": {
                                "message": { "type": "string" }
                            }
                        },
                        "warnings": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                },
                "Status": {
                    "type": "object",
                    "required": ["service", "product", "mode", "bindAddress", "port"],
                    "properties": {
                        "service": { "type": "string", "const": "running" },
                        "product": { "type": "string", "const": "shipflow-service" },
                        "mode": { "type": "string", "enum": ["local", "lan"] },
                        "bindAddress": { "type": "string" },
                        "port": { "type": "integer", "minimum": 1, "maximum": 65535 }
                    }
                },
                "Capabilities": {
                    "type": "object",
                    "required": ["product", "apiVersion", "auth", "forceRefreshHeader", "routes"],
                    "properties": {
                        "product": { "type": "string", "const": "shipflow-service" },
                        "apiVersion": { "type": "string", "const": "v1" },
                        "auth": { "type": "string", "const": "bearer" },
                        "forceRefreshHeader": { "type": "string" },
                        "routes": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    }
                },
                "TrackResponse": {
                    "type": "object",
                    "required": ["url", "detail", "status_akhir", "pod", "history", "history_summary"],
                    "properties": {
                        "url": { "type": "string" },
                        "detail": { "type": "object", "additionalProperties": true },
                        "status_akhir": { "$ref": "#/components/schemas/TrackStatusAkhir" },
                        "pod": { "$ref": "#/components/schemas/TrackPod" },
                        "history": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/TrackHistoryEntry" }
                        },
                        "history_summary": { "type": "object", "additionalProperties": true }
                    }
                },
                "TrackStatusAkhir": {
                    "type": "object",
                    "properties": {
                        "status": { "type": ["string", "null"] },
                        "location": { "type": ["string", "null"] },
                        "officer_name": { "type": ["string", "null"] },
                        "officer_id": { "type": ["string", "null"] },
                        "datetime": { "type": ["string", "null"] }
                    }
                },
                "TrackPod": {
                    "type": "object",
                    "properties": {
                        "photo1_url": { "type": ["string", "null"] },
                        "photo2_url": { "type": ["string", "null"] },
                        "signature_url": { "type": ["string", "null"] },
                        "coordinate": { "type": ["string", "null"] },
                        "coordinate_map_url": { "type": ["string", "null"] }
                    }
                },
                "TrackHistoryEntry": {
                    "type": "object",
                    "required": ["tanggal_update", "detail_history"],
                    "properties": {
                        "tanggal_update": { "type": "string" },
                        "detail_history": { "type": "string" }
                    }
                },
                "BagResponse": {
                    "type": "object",
                    "required": ["url", "nomor_kantung", "items"],
                    "properties": {
                        "url": { "type": "string" },
                        "nomor_kantung": { "type": ["string", "null"] },
                        "items": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/BagItem" }
                        }
                    }
                },
                "BagItem": {
                    "type": "object",
                    "properties": {
                        "no": { "type": ["string", "null"] },
                        "no_resi": { "type": ["string", "null"] },
                        "no_resi_url": { "type": ["string", "null"] },
                        "kantor_kirim": { "type": ["string", "null"] },
                        "tanggal_kirim": { "type": ["string", "null"] },
                        "posisi_akhir": { "type": ["string", "null"] },
                        "status": { "type": ["string", "null"] },
                        "tanggal_update": { "type": ["string", "null"] },
                        "jatuh_tempo": { "type": ["string", "null"] },
                        "petugas_update": { "type": ["string", "null"] }
                    }
                },
                "ManifestResponse": {
                    "type": "object",
                    "required": ["url", "total_berat", "items"],
                    "properties": {
                        "url": { "type": "string" },
                        "total_berat": { "type": ["string", "null"] },
                        "items": {
                            "type": "array",
                            "items": { "$ref": "#/components/schemas/ManifestItem" }
                        }
                    }
                },
                "ManifestItem": {
                    "type": "object",
                    "properties": {
                        "no": { "type": ["string", "null"] },
                        "nomor_kantung": { "type": ["string", "null"] },
                        "nomor_kantung_url": { "type": ["string", "null"] },
                        "jenis_layanan": { "type": ["string", "null"] },
                        "berat": { "type": ["string", "null"] },
                        "status": { "type": ["string", "null"] },
                        "lokasi_akhir": { "type": ["string", "null"] },
                        "tanggal": { "type": ["string", "null"] }
                    }
                },
                "BatchTrackRequest": {
                    "type": "object",
                    "required": ["shipmentIds"],
                    "properties": {
                        "shipmentIds": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_BATCH_SHIPMENT_IDS,
                            "items": {
                                "type": "string",
                                "maxLength": MAX_BATCH_SHIPMENT_ID_LENGTH
                            }
                        },
                        "forceRefresh": { "type": "boolean", "default": false }
                    }
                },
                "BatchTrackJobStart": {
                    "type": "object",
                    "required": ["jobId", "status", "statusEndpoint", "resultEndpoint"],
                    "properties": {
                        "jobId": { "type": "string" },
                        "status": { "$ref": "#/components/schemas/BatchJobStatus" },
                        "statusEndpoint": { "type": "string" },
                        "resultEndpoint": { "type": "string" }
                    }
                },
                "BatchJobSnapshot": {
                    "type": "object",
                    "required": [
                        "jobId",
                        "status",
                        "total",
                        "completed",
                        "failed",
                        "cancelRequested",
                        "errorMessage",
                        "createdAt",
                        "updatedAt"
                    ],
                    "properties": {
                        "jobId": { "type": "string" },
                        "status": { "$ref": "#/components/schemas/BatchJobStatus" },
                        "total": { "type": "integer", "minimum": 0 },
                        "completed": { "type": "integer", "minimum": 0 },
                        "failed": { "type": "integer", "minimum": 0 },
                        "cancelRequested": { "type": "boolean" },
                        "errorMessage": { "type": ["string", "null"] },
                        "createdAt": { "type": "string", "format": "date-time" },
                        "updatedAt": { "type": "string", "format": "date-time" }
                    }
                },
                "BatchJobResultSnapshot": {
                    "allOf": [
                        { "$ref": "#/components/schemas/BatchJobSnapshot" },
                        {
                            "type": "object",
                            "required": ["results"],
                            "properties": {
                                "results": {
                                    "type": "array",
                                    "items": { "$ref": "#/components/schemas/BatchTrackJobItemResult" }
                                }
                            }
                        }
                    ]
                },
                "BatchTrackJobItemResult": {
                    "type": "object",
                    "required": ["id", "status", "data", "error"],
                    "properties": {
                        "id": { "type": "string" },
                        "status": { "type": "string", "enum": ["success", "error", "cancelled"] },
                        "data": {
                            "anyOf": [
                                { "$ref": "#/components/schemas/TrackResponse" },
                                { "type": "null" }
                            ]
                        },
                        "error": { "type": ["string", "null"] }
                    }
                },
                "BatchJobStatus": {
                    "type": "string",
                    "enum": ["queued", "running", "completed", "cancelled", "failed"]
                }
            }
        }
    });

    document["paths"]["/v1/track/{shipmentId}/html"] = tracking_html_path_document();
    document["components"]["schemas"]["TrackingHtmlResponse"] = tracking_html_response_schema();

    document
}

fn tracking_html_path_document() -> Value {
    json!({
        "get": {
            "summary": "Read raw upstream tracking HTML for one shipment ID",
            "description": "Returns the raw upstream tracking page HTML for diagnostics and parser experiments. Clients can use this payload to show a source-like preview, but should treat the HTML as untrusted content and render it only in a sandboxed iframe or another isolated viewer. Do not inject this HTML directly into the application DOM. Relative assets may need to be resolved against the returned data.url value.",
            "operationId": "getTrackingHtml",
            "tags": ["Lookup"],
            "parameters": [
                { "$ref": "#/components/parameters/ShipmentId" },
                { "$ref": "#/components/parameters/RequestId" }
            ],
            "responses": {
                "200": {
                    "description": "Raw upstream tracking HTML wrapped in the v1 response envelope. The HTML is not sanitized by ShipFlow Service.",
                    "content": {
                        "application/json": {
                            "schema": {
                                "allOf": [
                                    { "$ref": "#/components/schemas/EnvelopeBase" },
                                    {
                                        "type": "object",
                                        "required": ["data"],
                                        "properties": {
                                            "data": { "$ref": "#/components/schemas/TrackingHtmlResponse" }
                                        }
                                    }
                                ]
                            }
                        }
                    }
                },
                "400": { "$ref": "#/components/responses/BadRequest" },
                "401": { "$ref": "#/components/responses/Unauthorized" },
                "404": { "$ref": "#/components/responses/NotFound" },
                "502": { "$ref": "#/components/responses/BadGateway" }
            }
        }
    })
}

fn tracking_html_response_schema() -> Value {
    json!({
        "type": "object",
        "description": "Raw upstream tracking page response for source-like diagnostics. Treat the html value as untrusted content.",
        "required": ["url", "html"],
        "properties": {
            "url": {
                "type": "string",
                "description": "The upstream tracking URL used to fetch the HTML. Clients may use this as the base when resolving relative links, images, or styles."
            },
            "html": {
                "type": "string",
                "description": "Raw HTML returned by the upstream tracking page. This may be rendered in a sandboxed iframe through srcdoc for a source-like preview, but should not be injected directly into the main application DOM."
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::service_openapi_document;

    #[test]
    fn includes_lan_server_when_lan_is_enabled() {
        let document = service_openapi_document(18422, true);
        let servers = document["servers"]
            .as_array()
            .expect("OpenAPI servers should be an array");

        assert!(servers
            .iter()
            .any(|server| server["url"] == "http://{serviceHost}:18422"));
    }

    #[test]
    fn documents_bearer_auth_and_openapi_route() {
        let document = service_openapi_document(18422, false);

        assert_eq!(document["openapi"], "3.1.0");
        assert_eq!(
            document["components"]["securitySchemes"]["bearerAuth"]["scheme"],
            "bearer"
        );
        assert!(document["paths"]["/v1/openapi.json"]["get"].is_object());
    }

    #[test]
    fn documents_tracking_html_route() {
        let document = service_openapi_document(18422, false);

        assert_eq!(
            document["paths"]["/v1/track/{shipmentId}/html"]["get"]["operationId"],
            "getTrackingHtml"
        );
        assert!(document["components"]["schemas"]["TrackingHtmlResponse"].is_object());
        assert!(
            document["paths"]["/v1/track/{shipmentId}/html"]["get"]["description"]
                .as_str()
                .is_some_and(|description| description.contains("sandboxed iframe"))
        );
        assert!(
            document["components"]["schemas"]["TrackingHtmlResponse"]["properties"]["html"]
                ["description"]
                .as_str()
                .is_some_and(|description| description.contains("srcdoc"))
        );
    }
}
