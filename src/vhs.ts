import path from "node:path";
import { MediaInspector } from "./inspect.js";
import { ManifestAudit } from "./manifest.js";
import { ManifestDiff } from "./manifest-diff.js";
import { StreamerService } from "./stream/service.js";
import { HlsWatchService } from "./watch.js";
import { PlaybackTriageService } from "./playback.js";

export type VhsOptions = {
  /** Directory that contains local cloned origins. Default: ./.vhs-data */
  dataDir?: string;
};

/** The small public surface for deterministic media work. */
export class Vhs {
  readonly inspect = new MediaInspector();
  readonly manifest = {
    audit: new ManifestAudit(this.inspect),
    diff: new ManifestDiff(new ManifestAudit(this.inspect)),
  };

  readonly stream: StreamerService;
  readonly watch = new HlsWatchService(this.inspect);
  readonly playback = new PlaybackTriageService();

  constructor(options: VhsOptions = {}) {
    const dataDir = path.resolve(options.dataDir ?? process.env.VHS_DATA_DIR ?? ".vhs-data");
    this.stream = new StreamerService(this.inspect, path.join(dataDir, "origins"));
  }
}

export async function createVhs(options: VhsOptions = {}): Promise<Vhs> {
  const vhs = new Vhs(options);
  await vhs.stream.init();
  return vhs;
}
