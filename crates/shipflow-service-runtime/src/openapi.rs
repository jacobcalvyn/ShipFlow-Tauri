use serde_json::{json, Value};
use shipflow_core::upstream::MAX_LOOKUP_ID_LENGTH;

use crate::{api_contract::REQUEST_ID_HEADER_NAME, FORCE_REFRESH_HEADER_NAME};

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
            "description": "Authenticated local/LAN API for third-party ShipFlow integrations. ShipFlow Desktop uses a separate native IPC transport. ShipFlow Service exposes only the versioned /v1 HTTP surface; unversioned legacy routes are not served."
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
                    "description": "Public identity probe used before sending a bearer token to a configured ShipFlow Service endpoint.",
                    "operationId": "getStatus",
                    "tags": ["Discovery"],
                    "security": [],
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
                        }
                    }
                }
            },
            "/v1/auth/check": {
                "get": {
                    "summary": "Validate the configured service bearer token",
                    "operationId": "checkAuth",
                    "tags": ["Discovery"],
                    "parameters": [{ "$ref": "#/components/parameters/RequestId" }],
                    "responses": {
                        "200": {
                            "description": "Bearer token is valid for this ShipFlow Service instance",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "allOf": [
                                            { "$ref": "#/components/schemas/EnvelopeBase" },
                                            {
                                                "type": "object",
                                                "required": ["data"],
                                                "properties": {
                                                    "data": { "$ref": "#/components/schemas/AuthCheck" }
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
                        "429": { "$ref": "#/components/responses/TooManyRequests" },
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
                        "429": { "$ref": "#/components/responses/TooManyRequests" },
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
                        "429": { "$ref": "#/components/responses/TooManyRequests" },
                        "502": { "$ref": "#/components/responses/BadGateway" }
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
                    "schema": { "type": "string", "maxLength": MAX_LOOKUP_ID_LENGTH }
                },
                "BagId": {
                    "name": "bagId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string", "maxLength": MAX_LOOKUP_ID_LENGTH }
                },
                "ManifestId": {
                    "name": "manifestId",
                    "in": "path",
                    "required": true,
                    "schema": { "type": "string", "maxLength": MAX_LOOKUP_ID_LENGTH }
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
                "TooManyRequests": {
                    "description": "Too many upstream lookup requests are already in flight or queued",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorEnvelope" } } }
                },
                "PayloadTooLarge": {
                    "description": "Request payload is too large",
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
                "AuthCheck": {
                    "type": "object",
                    "required": ["product", "auth", "status"],
                    "properties": {
                        "product": { "type": "string", "const": "shipflow-service" },
                        "auth": { "type": "string", "const": "bearer" },
                        "status": { "type": "string", "const": "ok" }
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
                        "history_summary": { "type": "object", "additionalProperties": true },
                        "contact_enrichment": { "$ref": "#/components/schemas/ContactEnrichmentMetadata" }
                    }
                },
                "ContactEnrichmentMetadata": {
                    "type": "object",
                    "required": ["source", "status", "sender_phone_present", "recipient_phone_present"],
                    "description": "Best-effort contact enrichment metadata. The primary tracking data remains sourced from POS PID detail; lacak-mitra is used only to fill sender/recipient phone numbers.",
                    "properties": {
                        "source": { "type": "string", "const": "lacak_mitra" },
                        "status": {
                            "type": "string",
                            "enum": ["cache_hit", "fetched", "missing", "failed", "skipped"]
                        },
                        "sender_phone_present": { "type": "boolean" },
                        "recipient_phone_present": { "type": "boolean" }
                    }
                },
                "TrackStatusAkhir": {
                    "type": "object",
                    "properties": {
                        "status": { "type": ["string", "null"] },
                        "location": { "type": ["string", "null"] },
                        "officer_name": { "type": ["string", "null"] },
                        "officer_id": { "type": ["string", "null"] },
                        "datetime": { "type": ["string", "null"], "description": "Clean final status timestamp formatted as YYYY-MM-DD HH:mm:ss when available." },
                        "date": { "type": ["string", "null"], "description": "Final status date formatted as YYYY-MM-DD when available." },
                        "time": { "type": ["string", "null"], "description": "Final status time formatted as HH:mm:ss when available." }
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
                "429": { "$ref": "#/components/responses/TooManyRequests" },
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
        assert!(document["paths"]["/v1/auth/check"]["get"].is_object());
        assert_eq!(
            document["paths"]["/v1/status"]["get"]["security"]
                .as_array()
                .map(Vec::len),
            Some(0)
        );
        assert!(document["paths"]["/v1/track/{shipmentId}"]["get"].is_object());
    }

    #[test]
    fn documents_only_versioned_routes() {
        let document = service_openapi_document(18422, false);
        let paths = document["paths"]
            .as_object()
            .expect("paths should be an OpenAPI object");

        for legacy_path in [
            "/health",
            "/status",
            "/track/{shipmentId}",
            "/bag/{bagId}",
            "/manifest/{manifestId}",
        ] {
            assert!(
                !paths.contains_key(legacy_path),
                "legacy path should not be documented: {legacy_path}"
            );
        }

        assert!(paths.keys().all(|path| path.starts_with("/v1/")));
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
