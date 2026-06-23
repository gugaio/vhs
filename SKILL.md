# VHS — Video Harness System

Ferramentas determinísticas para inspecionar, auditar e comparar streams HLS/DASH via CLI.

## Primeiro contato

```bash
# Auditar um manifesto HLS
vhs audit https://example.test/master.m3u8 --json

# Inspecionar um manifesto (HLS ou DASH)
vhs inspect https://example.test/master.m3u8 --json
vhs inspect https://example.test/manifest.mpd --format dash --json

# Clonar uma stream para análise local
vhs clone https://example.test/master.m3u8 --duration 60 --json

# Servir uma origin clonada localmente
vhs serve <origin-id>

# Monitorar uma live HLS
vhs live <origin-id> --port 8080

# Comparar dois manifests
vhs diff https://example.test/v1.m3u8 https://example.test/v2.m3u8 --json
```

## Comandos CLI

| Comando | Descrição | Flags principais |
|---------|-----------|-----------------|
| `audit <url>` | Auditoria estrutural de HLS | `--follow-variants`, `--max-segments`, `--json` |
| `inspect <url>` | Parse de HLS/DASH | `--format auto/hls/dash`, `--max-segments`, `--json` |
| `diff <left> <right>` | Comparação de manifests HLS | `--follow-variants`, `--json` |
| `clone <url>` | Download local da stream | `--duration`, `--variant`, `--all-variants`, `--id`, `--json` |
| `origins` | Listar origins clonadas | `--json` |
| `origin <id>` | Detalhes de uma origin | `--json` |
| `probe <id>` | ffprobe na origin | `--timeout-ms`, `--json` |
| `analyze <id>` | Análise profunda de segments | `--full`, `--json` |
| `mutate <id>` | Injetar falhas (discontinuity/segment-swap) | `--fault`, `--at-segment`, `--id`, `--json` |
| `remove <id>` | Remover origin | `--yes` |
| `serve <id>` | Servir origin como HTTP estático | `--host`, `--port` |
| `live <id>` | Servir origin como live simulada | `--host`, `--port`, `--window-size` |

Formato de saída: sem `--json` → texto amigável; com `--json` → JSON completo em stdout, progresso em stderr.

## Estrutura JSON de retorno

### `vhs audit --json`
```json
{
  "ok": true,
  "playlistType": "master",
  "stats": { "variants": 5, "segments": 0 },
  "issues": [{ "code": "single_variant_ladder", "severity": "warning", "summary": "...", "evidence": [] }],
  "variantAudits": [{ "uri": "...", "ok": true, "stats": { "segments": 10, "targetDuration": 6 }, "issues": [] }],
  "aggregateIssues": [],
  "recommendations": ["..."]
}
```

### `vhs inspect --json` (HLS)
```json
{
  "ok": true,
  "playlistType": "master",
  "variants": [{ "uri": "...", "bandwidth": 5000000, "resolution": "1920x1080", "codecs": "avc1.64001f" }],
  "renditions": [{ "type": "AUDIO", "groupId": "aac", "language": "en" }],
  "segments": [{ "uri": "...", "duration": 6 }],
  "targetDuration": 6,
  "discontinuityMarkers": [3]
}
```

### `vhs inspect --json` (DASH)
```json
{
  "ok": true,
  "type": "static",
  "representations": [{ "id": "video-1", "contentType": "video", "codecs": "avc1.64001f", "bandwidth": 5000000, "width": 1920, "height": 1080, "segments": [] }]
}
```

### `vhs diff --json`
```json
{
  "ok": true,
  "delta": { "variants": 0, "segments": -2 },
  "issueDiff": { "added": [], "removed": [{ "code": "...", "severity": "warning" }], "persisted": [] },
  "variantDiff": {
    "added": [], "removed": [],
    "changed": [{ "matchKey": "...", "status": "changed", "changedFields": ["bandwidth"] }],
    "regressed": [{ "matchKey": "...", "status": "regressed", "regressionSeverity": "high", "regressionScore": 80 }],
    "improved": [], "unchanged": []
  },
  "recommendations": []
}
```

### `vhs clone --json`
```json
{
  "id": "abc123",
  "originId": "abc123",
  "manifestPath": "/path/to/origins/abc123/master.m3u8",
  "variantCount": 3,
  "renditionCount": 1,
  "segmentCount": 30,
  "variants": [{ "uri": "...", "segments": 10 }],
  "renditions": []
}
```

### `vhs analyze --json`
```json
{
  "originId": "abc123",
  "ok": true,
  "sampledSegments": 30,
  "okSegments": 30,
  "failedSegments": 0,
  "media": [{ "uri": "...", "segments": [{ "uri": "...", "ok": true, "probe": { "format": {}, "streams": [] } }] }],
  "avAlignment": { "matchedVideo": true, "matchedAudio": true, "issues": [] },
  "issues": [],
  "entries": []
}
```

### `vhs probe --json`
```json
{
  "ok": true,
  "input": "/path/to/file.ts",
  "format": { "format_name": "mpegts" },
  "streams": [{ "codec_type": "video", "codec_name": "h264" }],
  "keyframes": { "count": 5, "timestamps": [0.0, 6.0, 12.0] },
  "timeline": { "firstPtsTime": 0.0, "lastPtsTime": 30.0, "keyframeCount": 5, "maxKeyframeGapSeconds": 6.0 }
}
```

### `vhs mutate --json`
```json
{
  "origin": { "id": "mutated-abc", "variantCount": 3, "segmentCount": 30 },
  "fault": { "type": "discontinuity", "atSegment": 5 }
}
```

## Tipos de fault para mutação

- `discontinuity`: insere `#EXT-X-DISCONTINUITY` em um segmento específico
- `segment-swap`: troca um segmento por outro de origin diferente (`--with-origin`, `--with-segment`)

## Eventos de progresso (clone)

O `clone` emite eventos de progresso no stderr:

| Evento | Quando |
|--------|--------|
| `start` | Início do clone |
| `manifest_fetch` | Baixando manifesto raiz |
| `manifest_ready` | Manifesto processado |
| `variant_inspect` | Inspecionando variant |
| `variant_ready` | Variant pronta |
| `segment_download_start` | Baixando segmento |
| `segment_download_retry` | Retry de segmento |
| `segment_downloaded` | Segmento salvo (bytes, total) |
| `complete` | Clone concluído |

## Eventos de watch (monitoramento)

O `vhs.watch` detecta anomalias em live HLS:

| Código | Severidade | Descrição |
|--------|-----------|-----------|
| `discontinuity_inserted` | warning | EXT-X-DISCONTINUITY inserido |
| `media_sequence_gap` | warning/error | MediaSequence pulou segmentos |
| `stale_manifest` | error | Manifesto não avançou |
| `segment_duration_anomaly` | warning/error | Segmento muito curto ou longo |
| `audio_rendition_gap` | warning/error | Rendições de áudio sumiram |
| `poll_error` | error | Erro ao buscar manifesto |

## Dicas

- Para debug, sempre use `--json` — a saída inclui todos os detalhes dos issues
- O `audit` com `--follow-variants` é mais lento mas audita cada variant individualmente
- Origins ficam em `./.vhs-data/origins/` por padrão (ou `$VHS_DATA_DIR`)
- `serve` e `live` bloqueiam o terminal até Ctrl+C
- `probe` requer `ffprobe` instalado no sistema
- `analyze --full` processa todos os segmentos de cada variant; pode ser demorado
- O `diff` é útil em pipelines de CI/CD para detectar regressões entre deploys de manifests
- `mutate` com `segment-swap` requer uma origin de origem (`--with-origin`) e segmento (`--with-segment`)
- Formatos de variant selector no `clone`: `aac-highest`, `video-highest`, `lowest`, `highest`
