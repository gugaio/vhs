# VHS — Video Harness System

Ferramentas determinísticas para inspecionar, auditar e comparar streams HLS/DASH.

O VHS não conhece agentes, sessões, jobs ou LLMs. Ele oferece uma API TypeScript e
uma CLI para humanos, CI e qualquer runtime de agente.

## Primeiro corte

- inspect HLS/DASH e `ffprobe`;
- audit e diff de manifestos HLS;
- clone de origins HLS/DASH, probe, análise, mutation e origem HTTP/live;
- CLI com saída humana ou JSON.

```bash
vhs manifest audit https://example.test/master.m3u8 --json
vhs stream clone https://example.test/master.m3u8 --duration 60 --json
vhs stream analyze <origin-id> --full --json
vhs stream serve <origin-id>
```
