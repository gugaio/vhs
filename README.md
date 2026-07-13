# VHS — Video Harness Suite

Ferramentas determinísticas para inspecionar, auditar e comparar streams HLS/DASH.

O VHS não conhece agentes, sessões, jobs ou LLMs. Ele oferece uma API TypeScript e
uma CLI para humanos, CI e qualquer runtime de agente.

## Primeiro corte

- inspect HLS/DASH e `ffprobe`;
- audit e diff de manifestos HLS;
- monitoramento HLS e triagem deterministica de logs de playback;
- clone de origins HLS/DASH, probe, análise, mutation e origem HTTP/live;
- CLI com saída humana ou JSON.

```bash
vhs audit https://example.test/master.m3u8 --json
vhs clone https://example.test/master.m3u8 --duration 60 --json
vhs analyze <origin-id> --full --json
vhs serve <origin-id>
```
