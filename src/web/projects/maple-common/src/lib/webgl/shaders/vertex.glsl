#version 300 es
// Full-screen NDC triangle — no VBO, gl_VertexID-indexed.
//
// gl_VertexID 0 -> (-1, -1)   gl_VertexID 1 -> ( 3, -1)   gl_VertexID 2 -> (-1,  3)
// The triangle covers the [-1, 1] NDC quad with clipping outside;
// Tex coords are derived from NDC so UV (0, 0) is bottom-left.
//
// Plan 3 M2.1 — see docs/superpowers/plans/2026-04-25-plan-3-m2-webgl-shaders.md.

precision highp float;

out vec2 vTexCoord;

void main() {
    vec2 ndc = vec2(
        (gl_VertexID & 1) == 0 ? -1.0 : 3.0,
        (gl_VertexID & 2) == 0 ? -1.0 : 3.0
    );
    vTexCoord = (ndc + 1.0) * 0.5;
    gl_Position = vec4(ndc, 0.0, 1.0);
}
