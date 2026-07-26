// Render runtime config — the client-side mirror of the API's
// `GET/PUT /api/render/config` shape (#1062). Today it carries exactly one
// knob: the operator ramp/kill switch for the web GPU live-render path.

/** Resolved config as returned by `GET /api/render/config`. `source` says
 * whether the operator saved the value or the API fell back to its built-in
 * default, so the settings page can label it honestly. */
export interface RenderConfigResponse {
  gpu_live_render_enabled: boolean;
  source: {
    gpu_live_render_enabled: 'db' | 'default';
  };
}

/** Write shape for `PUT /api/render/config`. An omitted field leaves the
 * saved value alone; `null` clears it back to the built-in default. */
export interface RenderConfigPatch {
  gpu_live_render_enabled?: boolean | null;
}
