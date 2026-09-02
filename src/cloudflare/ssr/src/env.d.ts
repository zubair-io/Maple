// Augments the generated `Env` interface (worker-configuration.d.ts, from
// `wrangler types`) with the vars this Worker actually reads. TypeScript
// merges this with the generated `interface Env` since both are global
// ambient declarations (no import/export in either file).
interface Env {
	/** Public base URL of the Azure Blob Storage container this Worker
	 * fronts, e.g. "https://hornbeam.blob.core.windows.net/mapleaperture"
	 * (see wrangler.jsonc.example and .github/workflows/deploy-hosted.yml,
	 * which uploads the same build to the same account/container). */
	ORIGIN_BASE_URL: string;
}
