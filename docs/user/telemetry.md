# Diagnostics and privacy

Quixotic keeps runtime logs and traces on the machine that runs the app or server. Resource monitoring reads local process information. Agent feedback is saved locally.

## Export diagnostics to your own receiver

To export traces, metrics, or logs, explicitly set an OpenTelemetry endpoint in Settings or with `T3CODE_OTLP_*` or `OTEL_EXPORTER_OTLP_*` environment variables. Restart the server after changing its settings. Environment variables take precedence over saved settings.
