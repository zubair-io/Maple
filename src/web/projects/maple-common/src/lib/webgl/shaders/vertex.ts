// vertex.ts — full-screen NDC triangle, gl_VertexID-indexed, no VBO.
// GLSL ES 3.0 source. Plan 3 M2.1.
//
// Shipped as a TypeScript template literal so ng-packagr (which builds
// maple-common as a library) can include it without needing a bundler
// loader for `.glsl?raw` (the application builder supports that, but
// the library builder does not).

export const VERTEX_SHADER_SOURCE = /* glsl */ `#version 300 es
// Full-screen NDC triangle — no VBO, gl_VertexID-indexed.
//
// gl_VertexID 0 -> (-1, -1)   gl_VertexID 1 -> ( 3, -1)   gl_VertexID 2 -> (-1,  3)
// The triangle covers the [-1, 1] NDC quad with clipping outside;
// Tex coords are derived from NDC so UV (0, 0) is bottom-left.

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
`;
