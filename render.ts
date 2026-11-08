/*
 * From https://www.redblobgames.com/maps/mapgen4/
 * Copyright 2018, 2025 Red Blob Games <redblobgames@gmail.com>
 * @license Apache-2.0 <https://www.apache.org/licenses/LICENSE-2.0.html>
 *
 * This module uses webgl to render the generated maps
 */

/*
 * MODIFIED — this file is changed from upstream (Apache License 2.0, §4(b)).
 * Fork: github.com/RyanAHoag/mapgen4, branch agentic-grid, from upstream
 * redblobgames/mapgen4 commit c1d8cb0 (2026-03-29). Changed 2026-10-18:
 *   - an optional 3D colour table, set with setColormap3D(), looked up by
 *     height, rain and map row instead of height and rain only, so a colour
 *     can change across the map (for example colder towards the top).
 *   - with no table set the renderer draws exactly as upstream does.
 * Changed 2026-10-19:
 *   - the renderer takes an optional world size; the canvas, the textures it
 *     draws into and the view take its shape, so a wide world fills a wide
 *     picture. Left out, it is 1000×1000 and square, as upstream.
 *   - an optional tint by map position, set with setTint(): an RGBA picture
 *     of the world laid over the land's colour, its alpha saying how much.
 *     With no tint set the renderer draws exactly as upstream does.
 * Changed 2026-11-06:
 *   - an optional surface by map position, set with setSurface(): how much
 *     of each place is dunes, broadleaf trees and conifers, and how far it is
 *     inside or outside a forest. Fine relief — ridges across the wind,
 *     crowns of trees — is added to the heights the light reads, never to the
 *     height the colour is read by, so the existing light draws it. Trees
 *     stand thick in a forest's middle and thin out towards its edge, a few
 *     beyond it; each shades the ground behind it from the light.
 *   - an optional wobble of the colour lookup's rain and row, so grounds meet
 *     along wandering lines rather than along the rain's contours and the
 *     table's rows.
 *   - both are set with the view (updateView's surface_* keys); left out,
 *     and with no surface set, the renderer draws exactly as upstream does.
 * Changed 2026-11-08:
 *   - optional covers by map position, set with setCovers(): dead woods,
 *     rock, fields, marsh and towns, each thing on them — a bare tree, a
 *     boulder, a field, a reed clump, a building — standing whole or not at
 *     all by the cover at its own middle, so their edges are crisp. Fields and
 *     buildings take colours from a palette a row per id; buildings are boxes
 *     that lean up the page by their height, as the land does by
 *     mountain_height, taller towards a town's middle as much as it rises.
 *     Under fields and towns the land's slope is read wide, so its fine
 *     wrinkles do not buckle them. With no covers set the renderer draws
 *     exactly as upstream does.
 * See FORK.md for what this fork is and how it follows upstream.
 */

import {vec2, vec4, mat4} from 'gl-matrix';
import colormap from "./colormap.ts";
import Geometry from "./geometry.ts";
import type {Mesh} from "./types.d.ts";

//////////////////////////////////////////////////////////////////////
// WebGL wrappers

type Buffer = {
    bind(): void;
    vertexAttribPointer(index: GLuint, size: GLint, type: GLenum, normalized: GLboolean, stride: GLsizei, offset: GLintptr): void;
    subdata(offset: number, data: AllowSharedBufferSource): void;
}

type Program = {
    run(body: () => void): void;
    [name: `a_${string}`]: GLint;
    [name: `u_${string}`]: WebGLUniformLocation;
}

type Texture = {
    id: WebGLTexture;
    width: number;
    height: number;
    bind(): void;
    activate(register: GLint, uniform: WebGLUniformLocation): void;
}

type Framebuffer = {
    id: WebGLFramebuffer;
    texture: Texture | null;
    depth: boolean;
    bind(): void;
    viewport(): void;
    clear(r: number, g: number, b: number, a: number): void;
}

class WebGLWrapper {
    gl: WebGL2RenderingContext;

    constructor (canvas: HTMLCanvasElement) {
        this.gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
        if (!this.gl) { alert("This project requires WebGL 2."); return; }
        canvas.addEventListener('webglcontextlost', () => console.error("This project not handle WebGL context loss"));
        const ext_color_buffer_float = this.gl.getExtension('EXT_color_buffer_float'); // 99.93% support
        if (!ext_color_buffer_float) { alert("This project requires WebGL2 EXT_color_buffer_float"); }
    }

    createBuffer(options: {indices?: boolean, update: 'static' | 'dynamic', data: AllowSharedBufferSource}): Buffer {
        const {gl} = this;
        const target = options.indices ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, options.data, options.update === 'static'? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
        return {
            bind() {
                gl.bindBuffer(target, buffer);
            },
            vertexAttribPointer(index, size, type, normalized, stride, offset) {
                this.bind();
                gl.enableVertexAttribArray(index);
                gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
            },
            subdata(offset: number, data: AllowSharedBufferSource) {
                this.bind();
                gl.bufferSubData(target, offset, data);
            },
        };
    }

    createTexture(options: {width?: number, height?: number, mipmap?: boolean, image?: HTMLCanvasElement, data?: Uint8Array, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Texture {
        const {gl} = this;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        if (options.image) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.image);
        } else if (options.width && options.height) {
            gl.texStorage2D(gl.TEXTURE_2D, 1, options.internalFormat ?? gl.RGBA8, options.width, options.height);
            if (options.data) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, options.width, options.height, options.format ?? gl.RGBA, gl.UNSIGNED_BYTE, options.data);
            }
        } else {
            throw "createTexture needs either an image or a width✕height";
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter === 'linear'? gl.LINEAR : gl.NEAREST);
        if (options.mipmap) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter === 'linear'? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
            gl.generateMipmap(gl.TEXTURE_2D);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        return {
            id: texture,
            width: options.width ?? options.image.width,
            height: options.height ?? options.image.height,
            bind() {
                gl.bindTexture(gl.TEXTURE_2D, texture);
            },
            activate(register: GLint, uniform: WebGLUniformLocation) {
                if (register < gl.TEXTURE0 || register >= gl.TEXTURE7) throw "invalid texture register";
                gl.uniform1i(uniform, register - gl.TEXTURE0);
                gl.activeTexture(register);
                this.bind();
            }
        };
    }

    _createFramebufferWrapper(framebuffer: WebGLFramebuffer | null, texture: Texture | null, depth: boolean): Framebuffer {
        const {gl} = this;
        return {
            id: framebuffer,
            texture,
            depth,
            bind() {
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            },
            viewport() {
                this.bind();
                const image = this.texture ?? gl.canvas;
                gl.viewport(0, 0, image.width, image.height);
            },
            clear(r, g, b, a) {
                this.bind();
                gl.clearColor(r, g, b, a);
                gl.clear(gl.COLOR_BUFFER_BIT | (this.depth? gl.DEPTH_BUFFER_BIT : 0));
            },
        };
    }

    drawToScreen(): Framebuffer {
        return this._createFramebufferWrapper(null, null, true);
    }

    createFramebuffer(width: number, height: number, options: {depth?: boolean, internalFormat?: GLenum, format?: GLenum, filter: 'linear'|'nearest'}): Framebuffer {
        const {gl} = this;
        const texture = this.createTexture({width, height, internalFormat: options.internalFormat, format: options.format, filter: options.filter});
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.id, 0);

        if (options.depth) {
            const depthBuffer = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, texture.width, texture.height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        }

        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.error("Framebuffer is not complete:", status.toString(16));
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this._createFramebufferWrapper(framebuffer, texture, options.depth ?? false);
    }

    createProgram(name: string, vert: string, frag: string, setup: (gl: WebGL2RenderingContext, program: Program) => void): Program {
        const {gl} = this;

        function createShader(type, source): WebGLShader {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, "#version 300 es\n" + source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(`Error compiling shader for program ${name}`);
                console.error(gl.getShaderInfoLog(shader));
            }
            return shader;
        }

        const vs = createShader(gl.VERTEX_SHADER, vert);
        const fs = createShader(gl.FRAGMENT_SHADER, frag);
        const pr = gl.createProgram();
        gl.attachShader(pr, vs);
        gl.attachShader(pr, fs);
        gl.linkProgram(pr);

        if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
            console.error(`Error linking shaders for program ${name}`);
            console.error(gl.getProgramInfoLog(pr));
        }

        gl.validateProgram(pr);
        if (!gl.getProgramParameter(pr, gl.VALIDATE_STATUS)) {
            console.warn(`Warning while validating shaders for program ${name}`);
            console.warn(gl.getProgramInfoLog(pr));
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const vao = gl.createVertexArray();

        let program: Program = {
            run(body) {
                gl.bindVertexArray(vao);
                gl.useProgram(pr);
                body();
                gl.bindVertexArray(null);
            },
        };

        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_ATTRIBUTES); i++) {
            let name = gl.getActiveAttrib(pr, i).name;
            program[name] = gl.getAttribLocation(pr, name);
        }
        for (let i = 0; i < gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS); i++) {
            let name = gl.getActiveUniform(pr, i).name;
            program[name] = gl.getUniformLocation(pr, name);
        }

        gl.bindVertexArray(vao);
        setup(gl, program);
        gl.bindVertexArray(null);

        return program;
    }
}


//////////////////////////////////////////////////////////////////////
// Shaders

const vert_river = `
    precision highp float;
    uniform mat4 u_projection;
    in vec4 a_xyww; // x, y, width1, width2 (widths are constant across vertices)
    out vec2 v_riverwidth;
    out vec3 v_barycentric;
    void main() {
        v_riverwidth = a_xyww.ba;
        int index = gl_VertexID % 3;
        v_barycentric = vec3(index == 0, index == 1, index == 2);
        gl_Position = u_projection * vec4(a_xyww.xy, 0, 1);
    }`;

const frag_river = `
    precision mediump float;
    in vec2 v_riverwidth;
    in vec3 v_barycentric;
    out vec4 out_fragcolor;
    const vec3 blue = vec3(0.2, 0.5, 0.7);
    void main() {
        float xt = v_barycentric.r / (v_barycentric.b + v_barycentric.r);
        float dist = sqrt(v_barycentric.b*v_barycentric.b + v_barycentric.r*v_barycentric.r + v_barycentric.b*v_barycentric.r);
        float pos = 0.5;
        float width = 0.35 * mix(v_riverwidth.x, v_riverwidth.y, xt); // variable width from r side to b side
        // NOTE: I've tried using screen space derivatives to make widths consistent between adjacent triangles,
        // but it ended up looking worse, so I reverted it. I multiplied the width by 2.0 * fwidth(v_barycentric.g)
        // and removed the divide by / s_length[s] in setRiverGeometry().
        // NOTE: the smoothstep is from w + minwidth to w - antialias thickness, but antialias thickness should
        // be calculated based on the matrix transform because we want it to be roughly 1 pixel; the min width should
        // probably also be 1 pixel
        float in_river = smoothstep(width + 0.025, max(0.0, width - 0.05), abs(dist - pos));
        vec4 river_color = in_river * vec4(blue, 1);
        // HACK: for debugging - if (min(v_barycentric.r, min(v_barycentric.g, v_barycentric.b)) < 0.05) river_color = vec4(0, 0, 0, 1);
        out_fragcolor = river_color;
    }`;

const vert_land = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em; // NOTE: moisture channel unused
    out float v_e;
    out vec2 v_xy;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, 0, 1);
        v_xy = (1.0 + pos.xy) * 0.5;
        v_e = a_em.x;
        gl_Position = pos;
    }`;

 const frag_land = `
    precision highp float;
    uniform sampler2D u_water;
    uniform float u_outline_water;
    in float v_e;
    in vec2 v_xy;
    out vec4 out_elevation;
    void main() {
        float e = 0.5 * (1.0 + v_e);
        float river = texture(u_water, v_xy).a;
        if (e >= 0.5) {
            float bump = u_outline_water / 256.0;
            float L1 = e + bump;
            float L2 = (e - 0.5) * (bump * 100.0) + 0.5;
            // TODO: simplify equation
            e = min(L1, mix(L1, L2, river));
        }
        out_elevation = vec4(e, 0, 0, 1);
    }`;

const vert_depth = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    out float v_z;
    void main() {
        vec4 pos = u_projection * vec4(a_xy, max(0.0, a_em.x), 1);
        v_z = a_em.x;
        gl_Position = pos;
    }`;

const frag_depth = `
    precision highp float;
    in float v_z;
    out vec4 out_depth;
    void main() {
        out_depth = vec4(v_z, 0, 0, 1);
    }`;

const vert_drape = `
    precision highp float;
    uniform mat4 u_projection;
    in vec2 a_xy;
    in vec2 a_em;
    out vec2 v_em, v_uv, v_xy;
    out float v_z;
    // u_world_inverse rather than dividing by u_world: a division by a
    // uniform rounds differently from upstream's division by a constant, and
    // moved a few pixels at 1000×1000. The reciprocal rounds as it did.
    uniform vec2 u_world, u_world_inverse;
    void main() {
        v_em = a_em;
        vec2 xy_clamped = clamp(a_xy, vec2(0, 0), u_world);
        v_z = max(0.0, a_em.x); // oceans with e<0 still rendered at z=0
        if (xy_clamped != a_xy) { // boundary points
            v_z = -0.5;
            v_em = vec2(0.0, 0.0);
        }
        vec4 pos = vec4(u_projection * vec4(xy_clamped, v_z, 1));
        v_uv = a_xy * u_world_inverse;
        v_xy = (1.0 + pos.xy) * 0.5;
        gl_Position = pos;
    }`;

const frag_drape = `
    precision highp float;
    uniform sampler2D u_colormap;
    uniform highp sampler3D u_colormap3d;   // highp: samplers have no default precision in a fragment shader
    uniform float u_use_colormap3d;
    uniform sampler2D u_tint;               // over the land's colour, by map position; alpha is how much
    uniform float u_use_tint;
    // The surface, by map position: r dunes, g broadleaf, b conifers — how much,
    // 0 to 1 — and a the signed distance to a forest's edge, 128 + 2 per map
    // unit, more inside.
    uniform sampler2D u_surface;
    uniform float u_use_surface;
    uniform vec2 u_world;                   // the world in map units, as the vertex shader has it
    uniform vec2 u_wind;                    // the way the wind blows, in map units, y down
    uniform vec4 u_dunes;                   // spacing (map units), height, cover, -
    uniform vec4 u_trees;                   // crown (map units), height, shade, variety
    uniform vec4 u_edge;                    // taper and strays (map units), wobble of rain and of row
    // The covers by map position (setCovers): what stands on the land besides
    // trees and dunes, each how much from 0 to 1. u_cover0 r dead woods, g rock,
    // b fields, a marsh; u_cover1 r town, g how far towards a town's middle times
    // how much it rises, b how thick (the share of its things that stand), a -.
    // u_cover_ids: which palette row a farm or a town takes, 1 up, 0 none
    // (nearest); u_palette: up to five colours a row, alpha 0 past them (nearest).
    uniform sampler2D u_cover0, u_cover1, u_cover_ids, u_palette;
    uniform float u_use_cover, u_palette_rows;
    uniform float u_lean;                   // map units a unit of height leans up the page: mountain_height
    uniform sampler2D u_elevation;
    uniform sampler2D u_water;
    uniform sampler2D u_depth;
    uniform vec2 u_light_angle, u_inverse_texture_size;
    uniform float u_slope, u_flat,
                  u_ambient, u_overhead,
                  u_outline_strength, u_outline_coast, u_outline_water,
                  u_outline_depth, u_outline_threshold,
                  u_biome_colors;
    in vec2 v_uv, v_xy, v_em;
    in float v_z;
    out vec4 out_fragcolor;

    const vec3 neutral_land_biome = vec3(0.9, 0.8, 0.7);
    const vec3 neutral_water_biome = 0.8 * neutral_land_biome;

    // Hashes without sine, so they agree across GPUs.
    float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }
    vec2 hash22(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.xx + p3.yz) * p3.zy);
    }
    float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
                   mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
    }

    // Dunes: ridges across the wind, a long back up it and a short steep slip
    // face down it. The crests bend and wander, each ridge rises and falls
    // along its length and here and there breaks, and the sand comes and goes
    // in fields. Evenly spaced straight ridges read as corduroy, not sand.
    float dunesAt(vec2 w) {
        vec2 along = u_wind, across = vec2(-u_wind.y, u_wind.x);
        float L = u_dunes.x;
        float a = dot(w, along) / L, c = dot(w, across) / L;
        a += 1.8 * vnoise(vec2(c * 0.22, a * 0.05)) + 0.9 * vnoise(vec2(c * 0.6 + 17.0, a * 0.15 + 3.0));
        float ridge = floor(a), t = fract(a);
        float h = t < 0.78 ? pow(t / 0.78, 1.15) : pow(1.0 - (t - 0.78) / 0.22, 1.6);
        h *= smoothstep(0.15, 0.6, vnoise(vec2(c * 0.3 + ridge * 3.7, ridge * 1.3)));
        float field = smoothstep(1.0 - u_dunes.z, 1.25 - u_dunes.z, vnoise(w / (L * 7.0) + 5.0));
        return h * field;
    }

    // How far inside a forest a point is, in map units (outside, below 0).
    float forestAt(vec4 s) { return (s.a * 255.0 - 128.0) * 0.5; }

    // Trees: one a cell, jittered, standing only where the forest is thick
    // enough for it — a hash of the cell against the forest's density at the
    // cell's middle, which rises over the taper from the edge inwards and is
    // broken by noise into clumps and clearings — so a forest thins from its
    // middle to its edge and leaves a few trees beyond, rather than ending on
    // a line. Each tree is broadleaf or conifer by chance, in the share the
    // surface says, so two forests meet mingled. The tallest crown over a
    // point is the canopy there. x the height, 0 to 1; y which tree.
    vec2 crownsAt(vec2 w) {
        float size = u_trees.x;
        vec2 p = w / size, i = floor(p);
        float best = 0.0, id = 0.5;
        float taper = max(u_edge.x, 0.001);
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec2 cell = i + vec2(x, y);
                vec2 o = hash22(cell);
                vec2 centre = cell + 0.2 + 0.6 * o;
                vec4 s = texture(u_surface, centre * size / u_world);
                float wobble = vnoise(centre * size / max(0.5 * taper, 3.0) + 31.0) - 0.5;
                float density = smoothstep(-u_edge.y, taper, forestAt(s) + wobble * taper);
                if (hash12(cell + 11.7) >= density) continue;
                float cone = hash12(cell + 5.3) < s.b / max(s.g + s.b, 0.001) ? 1.0 : 0.0;
                float r = (0.36 + 0.24 * hash12(cell + 7.13)) * mix(0.7, 1.0, density) * mix(1.0, 0.8, cone);
                float d = length(p - centre) / r;
                if (d < 1.0) {
                    float h = mix(sqrt(1.0 - d * d), 1.0 - d, cone) * (0.7 + 0.3 * o.y);
                    if (h > best) { best = h; id = hash12(cell + 3.71); }
                }
            }
        }
        return vec2(best, id);
    }
    // Whether trees can stand near a point at all: inside a forest, or within its strays and a crown of it.
    bool wooded(vec4 s) { return u_trees.y > 0.0 && forestAt(s) > -(u_edge.y + u_edge.x + 2.0 * u_trees.x); }
    // The fine relief at a point, in the elevation texture's own units.
    float reliefAt(vec2 uv) {
        vec4 s = texture(u_surface, uv);
        vec2 w = uv * u_world;
        float h = wooded(s) ? u_trees.y * crownsAt(w).x : 0.0;
        if (s.r > 0.004) h += s.r * u_dunes.y * dunesAt(w);
        return h;
    }

    mat2 turned(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }
    // How far a point is from its cell's edge, in map units, for cells of size sz.
    float edgeIn(vec2 f, vec2 sz) { return min(min(f.x, 1.0 - f.x) * sz.x, min(f.y, 1.0 - f.y) * sz.y); }

    // **Whether a thing stands, whole**: the cover at its own middle against a
    // number of its own, and the share of things that stand there. Each tree,
    // rock, reed clump, field and building is drawn whole or not at all, so a
    // cover's edge is a ragged line of things, never a blur.
    bool stands(float cover, vec2 at, vec2 id) {
        float thick = texture(u_cover1, at / u_world).b;
        return cover >= 0.3 + 0.4 * hash12(id + 17.0) && hash12(id + 23.0) < thick;
    }
    // Whether a point is inside a cover, for what is laid as ground rather than
    // stood up — ash, rock, pools: a wandering line, crisp.
    float within(float cover, vec2 w) { return step(0.45 + 0.25 * (vnoise(w / 5.0) - 0.5), cover); }
    // A colour from a farm's or a town's palette: the row its id says, one of
    // its colours by pick, 0 to 1; the kind's own when it has none.
    vec3 paletteAt(vec2 at, float pick, vec3 own) {
        float row = floor(texture(u_cover_ids, at / u_world).r * 255.0 + 0.5);
        if (row < 0.5 || u_palette_rows < 0.5) return own;
        float v = (row - 0.5) / u_palette_rows, n = 0.0;
        for (int k = 0; k < 5; k++) if (texture(u_palette, vec2((float(k) + 0.5) / 5.0, v)).a > 0.5) n += 1.0;
        if (n < 0.5) return own;
        return texture(u_palette, vec2((min(n - 1.0, floor(pick * n)) + 0.5) / 5.0, v)).rgb;
    }

    // Dead woods: bare trees from above, a trunk and a star of thin limbs.
    float deadAt(vec2 w) {
        float size = 4.2;
        vec2 p = w / size, i = floor(p);
        float best = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec2 cell = i + vec2(x, y);
                vec2 centre = cell + 0.25 + 0.5 * hash22(cell + 41.0);
                if (!stands(texture(u_cover0, centre * size / u_world).r, centre * size, cell)) continue;
                vec2 q = p - centre;
                float r = length(q), R = 0.5 + 0.3 * hash12(cell + 2.3);
                if (r > R) continue;
                float arms = 4.0 + floor(hash12(cell + 3.1) * 3.0);
                float ang = atan(q.y, q.x) + hash12(cell + 7.7) * 6.2832 + 0.6 * r;
                float off = abs(fract(ang * arms / 6.2832 + 0.5) - 0.5) * 6.2832 / arms;
                float limb = smoothstep(0.075, 0.0, r * sin(off)) * (1.0 - r / R);
                float twig = smoothstep(0.05, 0.0, abs(fract(r * 7.0 + hash12(cell)) - 0.5) * r) * step(0.25, r) * (1.0 - r / R) * 0.5;
                float trunk = smoothstep(0.14, 0.02, r);
                best = max(best, max(max(limb, trunk), twig * step(off, 0.5)));
            }
        }
        return best;
    }

    // Badlands: gullies cut down the slope, branching, between bare ribs of
    // rock, and boulders fallen at their feet. x the relief, y the gully.
    vec2 rocksAt(vec2 w) {
        vec2 q = turned(0.5 * (vnoise(w / 90.0) - 0.5)) * w;
        vec2 warp = vec2(vnoise(q / 18.0), vnoise(q / 18.0 + 7.0)) * 6.0;
        float trunk = pow(1.0 - abs(vnoise(vec2((q.x + warp.x) / 4.5, (q.y + warp.y) / 26.0)) * 2.0 - 1.0), 10.0);
        float twig = pow(1.0 - abs(vnoise(vec2((q.x + warp.y) / 2.2, (q.y - warp.x) / 9.0) + 5.0) * 2.0 - 1.0), 12.0);
        float gully = max(trunk, 0.6 * twig);
        float size = 4.0;
        vec2 p = w / size, i = floor(p);
        float boulder = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec2 cell = i + vec2(x, y);
                if (hash12(cell + 8.8) > 0.35) continue;
                vec2 centre = cell + 0.2 + 0.6 * hash22(cell + 61.0);
                if (!stands(texture(u_cover0, centre * size / u_world).g, centre * size, cell)) continue;
                float r = 0.18 + 0.26 * hash12(cell + 4.4);
                float d = length(p - centre) / r;
                if (d < 1.0) boulder = max(boulder, pow(1.0 - d * d, 0.6) * (0.7 + 0.3 * hash12(cell + 1.9)));
            }
        }
        float rib = vnoise(q / 3.0) * (1.0 - gully);
        return vec2(0.5 * rib + 1.1 * boulder - 1.4 * gully, gully);
    }

    // Farmland: sections on a grid, square to the map in most parcels and
    // turned in a few, each a whole field, halves, quarters or long strips.
    // x present, y which colour, z the tracks and tree lines between, w the
    // rows in it; at, the field's middle, where its palette is read.
    vec4 farmAt(vec2 w, out vec2 at) {
        const float SECTION = 24.0;
        vec2 pc = floor(w / 130.0);
        float ph = hash12(pc + 71.0);
        float ang = ph < 0.65 ? 0.0 : (ph - 0.82) * 1.4;
        vec2 q = turned(ang) * w;
        vec2 g = q / SECTION, cell = floor(g), f = fract(g);
        float split = floor(hash12(cell + 9.0) * 5.0);
        vec2 sub = vec2(0.0), ff = f, size = vec2(SECTION);
        if (split == 1.0) { sub.x = step(0.5, f.x); ff.x = fract(f.x * 2.0); size.x *= 0.5; }
        else if (split == 2.0) { sub.y = step(0.5, f.y); ff.y = fract(f.y * 2.0); size.y *= 0.5; }
        else if (split == 3.0) { sub = step(0.5, f); ff = fract(f * 2.0); size *= 0.5; }
        else if (split == 4.0) {
            float n = 3.0 + floor(hash12(cell + 5.0) * 3.0);
            if (hash12(cell + 6.0) < 0.5) { sub.x = floor(f.x * n); ff.x = fract(f.x * n); size.x /= n; }
            else { sub.y = floor(f.y * n); ff.y = fract(f.y * n); size.y /= n; }
        }
        vec2 id = cell * 8.0 + sub;
        at = turned(-ang) * ((cell + (sub + 0.5) * (size / SECTION)) * SECTION);
        float present = stands(texture(u_cover0, at / u_world).b, at, id) ? 1.0 : 0.0;
        float edge = edgeIn(ff, size), road = edgeIn(f, vec2(SECTION));
        float track = smoothstep(0.75, 0.45, road);
        float line = smoothstep(0.35, 0.12, edge) * step(0.75, road) * (hash12(cell + 41.0) < 0.45 ? 1.6 : 0.6);
        float run = size.x > size.y ? ff.y * size.y : ff.x * size.x;
        return vec4(present, hash12(id + 13.0), max(track, line), 0.5 + 0.5 * sin(run * 6.2832 / 0.75));
    }
    // A farm's colours when it has none of its own.
    vec3 cropOf(float k) {
        if (k < 0.2) return vec3(0.23, 0.36, 0.17);
        if (k < 0.4) return vec3(0.45, 0.58, 0.27);
        if (k < 0.6) return vec3(0.70, 0.63, 0.46);
        if (k < 0.8) return vec3(0.47, 0.37, 0.27);
        return vec3(0.80, 0.71, 0.33);
    }

    // Marsh: reed clumps, thickest at the water, and many small pools between.
    // x the reeds, y the pool, z the pool's rim.
    vec3 marshAt(vec2 w, float cover) {
        float n = 0.55 * vnoise(w / 6.0) + 0.3 * vnoise(w / 2.6 + 7.0) + 0.15 * vnoise(w / 1.1 + 3.0);
        float wet = within(cover, w);
        float pool = smoothstep(0.6, 0.63, n) * wet;
        float rim = smoothstep(0.54, 0.6, n) * (1.0 - pool) * wet;
        float size = 1.9;
        vec2 p = w / size, i = floor(p);
        float reed = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec2 cell = i + vec2(x, y);
                if (hash12(cell + 5.5) > 0.55 + 0.4 * rim) continue;
                vec2 centre = cell + hash22(cell + 9.9);
                if (!stands(texture(u_cover0, centre * size / u_world).a, centre * size, cell)) continue;
                for (int k = 0; k < 4; k++) {
                    float a = 1.57 + (hash12(cell + float(k) * 1.7) - 0.5) * 1.6;
                    vec2 dir = vec2(cos(a), sin(a));
                    vec2 q = p - centre - 0.1 * vec2(float(k) - 1.5, 0.0);
                    float along = dot(q, dir), lat = dot(q, vec2(-dir.y, dir.x));
                    if (along > -0.05 && along < 0.55) reed = max(reed, smoothstep(0.06, 0.0, abs(lat)) * (1.0 - along / 0.55));
                }
            }
        }
        return vec3(reed * (1.0 - pool), pool, rim);
    }

    // A town: blocks of buildings on a street grid, each a box that leans up
    // the page by its height as the mountains do (u_lean) — its roof drawn
    // where it stands shifted north, its south wall between, a short shadow
    // beside it — taller towards the town's middle as much as it rises.
    // x what is seen: 0 the street, 1 a roof, 2 a wall, 3 shadow; y the
    // building's pick of its palette; z whether the block is paved. at, the
    // building's middle, where its palette is read.
    vec3 townAt(vec2 w, out vec2 at) {
        const vec2 BLOCK = vec2(10.0, 7.5);
        float lean = 0.016 * u_lean;
        vec2 b = floor(w / BLOCK);
        float seen = 0.0, pick = 0.0, front = -1e9;
        at = w;
        float paved = step(0.45, texture(u_cover1, (b + 0.5) * BLOCK / u_world).r);
        for (int j = 0; j <= 2; j++) {
            for (int i = -1; i <= 1; i++) {
                vec2 blk = b + vec2(i, j);
                vec2 o = blk * BLOCK + 0.9;
                vec2 inner = BLOCK - 1.8;
                vec2 lots = vec2(2.0 + floor(hash12(blk + 1.0) * 2.0), 2.0);
                for (int ly = 0; ly < 2; ly++) {
                    for (int lx = 0; lx < 3; lx++) {
                        if (float(lx) >= lots.x) continue;
                        vec2 lot = vec2(lx, ly);
                        vec2 cellSize = inner / lots;
                        vec2 p0 = o + lot * cellSize + 0.3, p1 = o + (lot + 1.0) * cellSize - 0.3;
                        vec2 id = blk * 4.0 + lot;
                        vec2 mid = (p0 + p1) * 0.5;
                        vec4 here = texture(u_cover1, mid / u_world);
                        if (!stands(here.r, mid, id)) continue;
                        float h = (1.2 + 3.0 * hash12(id + 3.0) * hash12(id + 5.0)) * (1.0 + 3.0 * here.g);
                        float L = h * lean;
                        if (w.x < p0.x || w.x > p1.x) {
                            // A shadow to the east of it, as long as it is tall.
                            if (w.x > p1.x && w.x < p1.x + 0.45 * L && w.y > p0.y - L * 0.4 && w.y < p1.y && seen < 0.5) seen = 3.0;
                            continue;
                        }
                        if (p1.y <= front) continue;
                        if (w.y >= p0.y - L && w.y < p1.y - L) { seen = 1.0; pick = hash12(id + 11.0); front = p1.y; at = mid; }
                        else if (w.y >= p1.y - L && w.y <= p1.y) { seen = 2.0; pick = hash12(id + 11.0); front = p1.y; at = mid; }
                    }
                }
            }
        }
        return vec3(seen, pick, paved);
    }

    // The fine relief the covers add to the heights the light reads: never a
    // farm's or a town's, which lie on level ground and draw their own faces.
    float coverReliefAt(vec2 uv) {
        vec4 c0 = texture(u_cover0, uv);
        vec2 w = uv * u_world;
        float h = 0.0;
        if (c0.r > 0.004) h += 0.016 * deadAt(w);
        if (c0.g > 0.004) h += 0.02 * within(c0.g, w) * rocksAt(w).x;
        if (c0.a > 0.004) { vec3 m = marshAt(w, c0.a); h += 0.014 * m.x - 0.003 * m.y; }
        return h;
    }

    void main() {
        vec2 sample_offset = 0.5 * u_inverse_texture_size;
        vec2 pos = v_uv + sample_offset;
        vec2 dx = vec2(u_inverse_texture_size.x, 0),
             dy = vec2(0, u_inverse_texture_size.y);

        float z  = texture(u_elevation, pos).x;
        float zE = texture(u_elevation, pos + dx).x;
        float zN = texture(u_elevation, pos - dy).x;
        float zW = texture(u_elevation, pos - dx).x;
        float zS = texture(u_elevation, pos + dy).x;
        // The surface's relief, added to the four heights the slope is read
        // from and not to z: it changes the light, never the colour by height.
        vec4 surface = vec4(0.0);
        if (u_use_surface > 0.5 && z >= 0.5) {
            surface = texture(u_surface, pos);
            if (surface.r > 0.004 || wooded(surface)) {
                zE += reliefAt(pos + dx); zN += reliefAt(pos - dy);
                zW += reliefAt(pos - dx); zS += reliefAt(pos + dy);
            }
        }
        vec4 cover0 = vec4(0.0), cover1 = vec4(0.0);
        if (u_use_cover > 0.5 && z >= 0.5) {
            cover0 = texture(u_cover0, pos); cover1 = texture(u_cover1, pos);
            if (max(cover0.r, max(cover0.g, cover0.a)) > 0.004) {
                zE += coverReliefAt(pos + dx); zN += coverReliefAt(pos - dy);
                zW += coverReliefAt(pos - dx); zS += coverReliefAt(pos + dy);
            }
        }
        // **Farms and cities lie on level ground**: under them the land's slope is
        // read across eight texels, not two, so its broad rise still shades them
        // but its fine wrinkles do not buckle the fields and the streets.
        float level = smoothstep(0.2, 0.7, max(cover0.b, cover1.r));
        if (level > 0.0) {
            float wE = texture(u_elevation, pos + 4.0 * dx).x, wW = texture(u_elevation, pos - 4.0 * dx).x;
            float wN = texture(u_elevation, pos - 4.0 * dy).x, wS = texture(u_elevation, pos + 4.0 * dy).x;
            zE = mix(zE, z + (wE - z) * 0.25, level); zW = mix(zW, z + (wW - z) * 0.25, level);
            zN = mix(zN, z + (wN - z) * 0.25, level); zS = mix(zS, z + (wS - z) * 0.25, level);
        }
        vec3 slope_vector = normalize(vec3(zS-zN, zE-zW, u_overhead * (u_inverse_texture_size.x + u_inverse_texture_size.y)));
        vec3 light_vector = normalize(vec3(u_light_angle, mix(u_slope, u_flat, slope_vector.z)));
        float light = u_ambient + max(0.0, dot(light_vector, slope_vector));
        vec3 neutral_biome_color = neutral_land_biome;
        vec4 water_color = texture(u_water, pos);
        bool on_land = z >= 0.5 && v_z >= 0.0;
        if (on_land) {
            // on land, lower the elevation around rivers
            z -= u_outline_water / 256.0 * (1.0 - water_color.a);
        } else {
            // in the ocean, or underground, don't draw rivers
            water_color.a = 0.0; neutral_biome_color = neutral_water_biome;
        }
        // On land, the rain and the row the colour is looked up by wander a
        // little, so grounds meet along wandering lines, not along the rain's
        // contours and the table's rows. Never the height: the coast and the
        // snow would move off the board's.
        vec2 jw = pos * u_world;
        float rain_at = v_em.y, row_at = v_uv.y;
        if (on_land) {
            rain_at += (vnoise(jw / 22.0) - 0.5 + 0.5 * (vnoise(jw / 7.0 + 3.0) - 0.5)) * u_edge.z;
            row_at += (vnoise(jw / 37.0 + 13.0) - 0.5) * u_edge.w;
        }
        vec3 biome_color = u_use_colormap3d > 0.5
            ? texture(u_colormap3d, vec3(z, rain_at, row_at)).rgb   // the third axis is the map's row, top to bottom
            : texture(u_colormap, vec2(z, rain_at)).rgb;
        if (u_use_tint > 0.5 && on_land) {
            vec4 tint = texture(u_tint, v_uv);
            biome_color = mix(biome_color, tint.rgb, tint.a);
        }
        // Trees: each crown shades the ground behind it from the light, the
        // floor between crowns is darker where the forest is thick, and no two
        // trees are quite one green.
        if (on_land && u_use_surface > 0.5 && wooded(surface)) {
            vec2 to_light = -normalize(vec2(u_light_angle.y, u_light_angle.x));
            vec2 crown = crownsAt(jw);
            float there = crownsAt(jw + to_light * u_trees.x * 0.45).x;
            float shadow = clamp((there - crown.x) * 1.5, 0.0, 1.0);
            float thick = smoothstep(0.0, max(u_edge.x, 0.001), forestAt(surface));
            float shade = u_trees.z * (0.55 * shadow + 0.25 * (1.0 - crown.x) * thick);
            float variety = crown.x > 0.0 ? u_trees.w * (crown.y - 0.5) : 0.0;
            biome_color *= (1.0 - shade) * (1.0 + variety);
        }
        // The covers: each laid crisp — ash, rock and pools inside a wandering
        // line, trees, fields and buildings whole — in colours that take the
        // palette's own light and colourfulness, so Gothic's farms are drained.
        if (on_land && u_use_cover > 0.5) {
            float grey = dot(biome_color, vec3(0.3, 0.59, 0.11));
            float hi = max(max(biome_color.r, biome_color.g), biome_color.b), lo = min(min(biome_color.r, biome_color.g), biome_color.b);
            float vivid = clamp((hi - lo) / max(hi, 0.001) * 3.2, 0.4, 1.0);
            float light_of = clamp(grey / 0.5, 0.6, 1.3);
            if (cover0.r > 0.004) {
                float wood = within(cover0.r, jw);
                biome_color = mix(biome_color, vec3(grey) * vec3(1.02, 0.97, 0.9), 0.7 * wood);
                biome_color *= 1.0 - 0.62 * deadAt(jw);
            }
            if (cover0.g > 0.004) {
                float rocky = within(cover0.g, jw);
                vec2 r = rocksAt(jw);
                // Layers of rock by height, as a slope cut through them shows them.
                float band = fract(z * 38.0 + 0.35 * vnoise(jw / 40.0));
                vec3 strata = band < 0.35 ? vec3(1.12, 0.86, 0.72) : band < 0.6 ? vec3(0.96, 0.9, 0.82) : band < 0.8 ? vec3(1.06, 0.78, 0.62) : vec3(0.88, 0.86, 0.84);
                strata = mix(vec3(1.0), strata, vivid);
                biome_color = mix(biome_color, vec3(grey) * strata * 1.05 * (1.0 - 0.5 * r.y), rocky);
            }
            if (cover0.b > 0.004) {
                vec2 at;
                vec4 f = farmAt(jw, at);
                vec3 crop = paletteAt(at, f.y, cropOf(f.y)) * mix(1.0, light_of, 0.6);
                crop = mix(vec3(dot(crop, vec3(0.3, 0.59, 0.11))), crop, vivid);
                float ploughed = dot(crop, vec3(0.3, 0.59, 0.11)) > 0.0 && crop.r > crop.g ? 0.12 : 0.04;
                crop *= 1.0 - ploughed * 0.5 + ploughed * f.w;
                vec3 track = vec3(0.70, 0.66, 0.56) * mix(1.0, light_of, 0.6);
                vec3 farm = f.z > 0.0 ? mix(crop, f.z > 1.0 ? crop * vec3(0.5, 0.62, 0.45) : track, min(1.0, f.z)) : crop;
                biome_color = mix(biome_color, farm, f.x);
            }
            if (cover0.a > 0.004) {
                vec3 m = marshAt(jw, cover0.a);
                float wet = within(cover0.a, jw);
                vec3 water = biome_color * vec3(0.5, 0.62, 0.66);
                vec3 rim = biome_color * vec3(0.85, 0.92, 0.84);
                vec3 reeds = biome_color * vec3(0.98, 1.02, 0.8) * (1.0 - 0.4 * m.x);
                biome_color = mix(biome_color, mix(mix(reeds, rim, m.z), water, m.y), wet);
            }
            if (cover1.r > 0.004) {
                vec2 at;
                vec3 c = townAt(jw, at);
                vec3 roof = paletteAt(at, c.y, c.y < 0.45 ? vec3(0.68, 0.38, 0.28) : c.y < 0.75 ? vec3(0.44, 0.45, 0.50) : vec3(0.82, 0.77, 0.66));
                roof *= mix(1.0, light_of, 0.5);
                roof = mix(vec3(dot(roof, vec3(0.3, 0.59, 0.11))), roof, vivid);
                vec3 street = vec3(0.60, 0.56, 0.50) * mix(1.0, light_of, 0.6);
                vec3 ground = c.z > 0.5 ? street : biome_color;
                biome_color = c.x > 1.5 && c.x < 2.5 ? roof * 0.58
                            : c.x > 0.5 && c.x < 1.5 ? roof
                            : c.x > 2.5 ? ground * 0.72
                            : ground;
            }
        }
        water_color = mix(vec4(neutral_water_biome * (1.2 - water_color.a), water_color.a), water_color, u_biome_colors);
        biome_color = mix(neutral_biome_color, biome_color, u_biome_colors);
        if (v_z < 0.0) {
            // at the exterior boundary, we'll draw soil or water underground
            float land_or_water = smoothstep(0.0, -0.001, v_em.x - v_z);
            vec3 soil_color = vec3(0.4, 0.3, 0.2);
            vec3 underground_color = mix(soil_color, mix(neutral_water_biome, vec3(0.1, 0.1, 0.2), u_biome_colors), land_or_water) * smoothstep(-0.7, -0.1, v_z);
            vec3 highlight_color = mix(vec3(0, 0, 0), mix(vec3(0.8, 0.8, 0.8), vec3(0.4, 0.5, 0.7), u_biome_colors), land_or_water);
            biome_color = mix(underground_color, highlight_color, 0.5 * smoothstep(-0.025, 0.0, v_z));
            light = 1.0 - 0.3 * smoothstep(0.8, 1.0, fract((v_em.x - v_z) * 20.0)); // add horizontal lines
        }
        // if (fract(z * 10.0) < 10.0 * fwidth(z)) { biome_color = vec3(0,0,0); } // contour lines

        // TODO: add noise texture based on biome

        float depth0 = texture(u_depth, v_xy).x,
              depth1 = max(max(texture(u_depth, v_xy + u_outline_depth*(-dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(-dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(-dy)).x),
              depth2 = max(max(texture(u_depth, v_xy + u_outline_depth*(dy-dx)).x,
                               texture(u_depth, v_xy + u_outline_depth*(dy+dx)).x),
                           texture(u_depth, v_xy + u_outline_depth*(dy)).x);
        float outline = 1.0 + u_outline_strength * (max(u_outline_threshold, depth1-depth0) - u_outline_threshold);

        // Add coast outline, but avoid it if there's a river nearby
        float neighboring_river = max(
            max(
                texture(u_water, pos + u_outline_depth * dx).a,
                texture(u_water, pos - u_outline_depth * dx).a
            ),
            max(
                texture(u_water, pos + u_outline_depth * dy).a,
                texture(u_water, pos - u_outline_depth * dy).a
            )
        );
        if (z <= 0.5 && max(depth1, depth2) > 1.0/256.0 && neighboring_river <= 0.2) { outline += u_outline_coast * 256.0 * (max(depth1, depth2) - 2.0*(z - 0.5)); }

        out_fragcolor = vec4(mix(biome_color, water_color.rgb, water_color.a) * light / outline, 1);
    }`;

const vert_final = `
    precision highp float;
    in vec2 a_uv;
    out vec2 v_uv;
    void main() {
        v_uv = a_uv;
        gl_Position = vec4(2.0 * v_uv - 1.0, 0.0, 1.0);
    }`;

const frag_final = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec2 u_offset;
    in vec2 v_uv;
    out vec4 out_fragcolor;
    void main() {
         out_fragcolor = texture(u_texture, v_uv + u_offset);
    }`;

//////////////////////////////////////////////////////////////////////
// Mapgen4 renderer

const fbo_texture_size: number = 2048;

export default class Renderer {
    numRiverTriangles: number = 0;

    /* The world's size in map units, and the picture's in pixels: the longer
     * side fbo_texture_size, the other in proportion. */
    world: {width: number, height: number};
    picture: {width: number, height: number};

    topdown: mat4;
    projection: mat4;
    inverse_projection: mat4;

    a_quad_xy: Float32Array;
    a_quad_em: Float32Array;
    quad_elements_length: number; // have to store the original size because the worker thread borrows the actual array
    quad_elements: Int32Array;
    a_river_xyww: Float32Array;

    screenshotCanvas: HTMLCanvasElement;
    screenshotCallback: () => void;
    renderParam: any;

    webgl: WebGLWrapper;

    texture_colormap: Texture;
    /* The optional 3D colour table: a 1×1×1 stand-in until one is set, so the
     * sampler always has a texture; use_colormap3d says whether to read it. */
    texture_colormap3d: WebGLTexture;
    use_colormap3d: number = 0;
    /* The optional tint by map position: a 1×1 stand-in until one is set. */
    texture_tint: Texture;
    use_tint: number = 0;
    /* The optional surface by map position: a 1×1 stand-in, no forest anywhere, until one is set. */
    texture_surface: Texture;
    use_surface: number = 0;
    /* The optional covers by map position, their ids and their palettes: 1×1 stand-ins, nothing anywhere, until set. */
    texture_cover0: Texture;
    texture_cover1: Texture;
    texture_cover_ids: Texture;
    texture_palette: Texture;
    palette_rows: number = 0;
    use_cover: number = 0;

    fbo_river: Framebuffer;
    fbo_land: Framebuffer;
    fbo_depth: Framebuffer;
    fbo_drape: Framebuffer;

    program_river: Program;
    program_land: Program;
    program_depth: Program;
    program_drape: Program;
    program_final: Program;

    buffer_fullscreen: Buffer;
    buffer_quad_xy: Buffer;
    buffer_quad_em: Buffer;
    buffer_quad_elements: Buffer;
    buffer_river_xyww: Buffer;

    constructor (mesh: Mesh, world: {width: number, height: number} = {width: 1000, height: 1000}) {
        const canvas = document.getElementById('mapgen4') as HTMLCanvasElement;
        this.webgl = new WebGLWrapper(canvas);

        this.world = world;
        const longer = Math.max(world.width, world.height);
        this.picture = {
            width: Math.round(fbo_texture_size * world.width / longer),
            height: Math.round(fbo_texture_size * world.height / longer),
        };
        this.resizeCanvas();

        this.topdown = mat4.create();
        mat4.translate(this.topdown, this.topdown, [-1, -1, 0]);
        mat4.scale(this.topdown, this.topdown, [2/world.width, 2/world.height, 1]);

        this.projection = mat4.create();
        this.inverse_projection = mat4.create();

        this.a_quad_xy = new Float32Array(2 * (mesh.numRegions + mesh.numTriangles));
        this.a_quad_em = new Float32Array(2 * (mesh.numRegions + mesh.numTriangles));
        this.quad_elements_length = 3 * mesh.numSolidSides;
        this.quad_elements = new Int32Array(this.quad_elements_length);
        /* NOTE: The maximum number of river triangles will be when
         * there's a single binary tree that has every node filled.
         * Each of the N/2 leaves will produce 1 output triangle and
         * each of the N/2 nodes will produce 2 triangles. On average
         * there will be 1.5 output triangles per input triangle. */
        const numRiverVertices = 1.5 /* river triangles per input triangle */ * 3 /* vertices per triangle */ * mesh.numSolidTriangles;
        this.a_river_xyww = new Float32Array(numRiverVertices * 4);

        Geometry.setMeshGeometry(mesh, this.a_quad_xy);

        this.buffer_quad_xy = this.webgl.createBuffer({update: 'static', data: this.a_quad_xy});
        this.buffer_quad_em = this.webgl.createBuffer({update: 'dynamic', data: this.a_quad_em});
        this.buffer_quad_elements = this.webgl.createBuffer({indices: true, update: 'dynamic', data: this.quad_elements});

        this.buffer_fullscreen = this.webgl.createBuffer({update: 'static', data: new Float32Array([-2, 0, 0, -2, 2, 2])});
        this.buffer_river_xyww = this.webgl.createBuffer({update: 'dynamic', data: this.a_river_xyww});

        this.texture_colormap = this.webgl.createTexture({data: colormap.data, width: colormap.width, height: colormap.height, filter: 'nearest'});
        this.texture_colormap3d = this.createColormap3D();
        this.texture_tint = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'linear'});
        this.texture_surface = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'linear'});
        this.texture_cover0 = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'linear'});
        this.texture_cover1 = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'linear'});
        this.texture_cover_ids = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'nearest'});
        this.texture_palette = this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'nearest'});

        const {width: pw, height: ph} = this.picture;
        this.fbo_land  = this.webgl.createFramebuffer(pw, ph, {depth: false, internalFormat: this.webgl.gl.R16F, filter: 'linear'});
        this.fbo_depth = this.webgl.createFramebuffer(pw, ph, {depth: true, internalFormat: this.webgl.gl.R16F, filter: 'nearest'}); // NOTE: linear requires adjusting parameters
        this.fbo_river = this.webgl.createFramebuffer(pw, ph, {depth: false, filter: 'linear'}); // linear makes rivers look better
        this.fbo_drape = this.webgl.createFramebuffer(pw, ph, {depth: true, filter: 'linear'}); // linear to smooth out edges

        this.program_river = this.webgl.createProgram('river', vert_river, frag_river, (gl, program) => {
            this.buffer_river_xyww.vertexAttribPointer(program.a_xyww, 4, gl.FLOAT, false, 0, 0);
        });
        this.program_land  = this.webgl.createProgram('land', vert_land,  frag_land, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_depth = this.webgl.createProgram('depth', vert_depth, frag_depth, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_drape = this.webgl.createProgram('drape', vert_drape, frag_drape, (gl, program) => {
            this.buffer_quad_xy.vertexAttribPointer(program.a_xy, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_em.vertexAttribPointer(program.a_em, 2, gl.FLOAT, false, 0, 0);
            this.buffer_quad_elements.bind();
        });
        this.program_final = this.webgl.createProgram('final', vert_final, frag_final, (gl, program) => {
            this.buffer_fullscreen.vertexAttribPointer(program.a_uv, 2, gl.FLOAT, false, 0, 0);
        });

        this.screenshotCanvas = document.createElement('canvas');
        this.screenshotCanvas.width = pw;
        this.screenshotCanvas.height = ph;
        this.screenshotCallback = null;

        this.renderParam = undefined;
        this.startDrawingLoop();
    }

    /* A 3D texture, made directly: WebGLWrapper.createTexture only makes 2D
     * ones. Clamped on all three axes, or the top row would bleed into the
     * bottom one; linear, so colours blend between rows. */
    createColormap3D(): WebGLTexture {
        const {gl} = this.webgl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, texture);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
            gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
        }
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_3D, null);
        return texture;
    }

    /* Colour by (height, rain, map row) from this table: width is height
     * (-1 to +1, as the 2D colormap), height is rain (0 to 1), depth is the
     * map's rows from top to bottom. Pass null to go back to the 2D colormap.
     * WebGL 2 promises 256 texels per side for a 3D texture. */
    setColormap3D(data: Uint8Array | null, width: number, height: number, depth: number) {
        if (!data) { this.use_colormap3d = 0; return; }
        const {gl} = this.webgl;
        gl.bindTexture(gl.TEXTURE_3D, this.texture_colormap3d);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, width, height, depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_3D, null);
        this.use_colormap3d = 1;
    }

    /* A tint over the land by map position: RGBA, row 0 the top of the world,
     * alpha how much of the tint's colour replaces the land's. Linear, so a
     * small picture still lies smoothly. Pass null to take it away. */
    setTint(data: Uint8Array | null, width: number, height: number) {
        if (!data) { this.use_tint = 0; return; }
        const {gl} = this.webgl;
        if (this.texture_tint.width !== width || this.texture_tint.height !== height) {
            gl.deleteTexture(this.texture_tint.id);   // its storage is fixed at its size
            this.texture_tint = this.webgl.createTexture({width, height, data, filter: 'linear'});
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.texture_tint.id);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        this.use_tint = 1;
    }

    /* The surface by map position: RGBA, row 0 the top of the world; r dunes,
     * g broadleaf trees, b conifers, each how much from 0 to 255, and a the
     * signed distance to a forest's edge, 128 + 2 per map unit, more inside.
     * Linear, so a small picture lies smoothly. Null takes it away. What it
     * looks like is set with the view: surface_wind [x, y], surface_dunes
     * [spacing, height, cover, 0], surface_trees [crown, height, shade,
     * variety], surface_edge [taper, strays, rain wobble, row wobble]. */
    setSurface(data: Uint8Array | null, width: number, height: number) {
        if (!data) { this.use_surface = 0; return; }
        const {gl} = this.webgl;
        if (this.texture_surface.width !== width || this.texture_surface.height !== height) {
            gl.deleteTexture(this.texture_surface.id);   // its storage is fixed at its size
            this.texture_surface = this.webgl.createTexture({width, height, data, filter: 'linear'});
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.texture_surface.id);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        this.use_surface = 1;
    }

    /* The covers by map position, row 0 the top of the world, each RGBA and
     * as big as the surface: `layer0` r dead woods, g rock, b fields, a marsh;
     * `layer1` r town, g how far towards a town's middle times how much it
     * rises, b how thick, a unused — each how much from 0 to 255, linear. Each
     * thing on them stands whole or not at all, by the cover at its own middle.
     * `ids`: which row of `palette` a farm's or a town's pixel takes, in r, 1
     * up, 0 none (nearest). `palette`: RGBA, 5 wide and a row an id, alpha 255
     * on each colour used. Buildings lean by the view's mountain_height. Null
     * takes them away. */
    setCovers(covers: {layer0: Uint8Array; layer1: Uint8Array; ids: Uint8Array; width: number; height: number; palette: Uint8Array; rows: number} | null) {
        if (!covers) { this.use_cover = 0; return; }
        const {gl} = this.webgl, {width, height, rows} = covers;
        for (const t of [this.texture_cover0, this.texture_cover1, this.texture_cover_ids, this.texture_palette]) gl.deleteTexture(t.id);
        this.texture_cover0 = this.webgl.createTexture({width, height, data: covers.layer0, filter: 'linear'});
        this.texture_cover1 = this.webgl.createTexture({width, height, data: covers.layer1, filter: 'linear'});
        this.texture_cover_ids = this.webgl.createTexture({width, height, data: covers.ids, filter: 'nearest'});
        this.texture_palette = rows > 0
            ? this.webgl.createTexture({width: 5, height: rows, data: covers.palette, filter: 'nearest'})
            : this.webgl.createTexture({width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]), filter: 'nearest'});
        this.palette_rows = rows;
        this.use_cover = 1;
    }

    screenToWorld(coords: [number, number]): vec2 {
        /* convert from screen 2d (inverted y) to 4d for matrix multiply */
        let glCoords = vec4.fromValues(
            coords[0] * 2 - 1,
            1 - coords[1] * 2,
            /* TODO: z should be 0 only when tilt_deg is 0;
             * need to figure out the proper z value here */
            0,
            1
        );
        /* it returns vec4 but we only need vec2; they're compatible */
        let transformed = vec4.transformMat4(vec4.create(), glCoords, this.inverse_projection);
        return [transformed[0], transformed[1]];
    }

    /* Update the buffers with the latest map data */
    updateMap() {
        this.buffer_quad_em.subdata(0, this.a_quad_em);
        this.buffer_quad_elements.subdata(0, this.quad_elements);
        this.buffer_river_xyww.subdata(0, this.a_river_xyww.subarray(0, 4 * 3 * this.numRiverTriangles));
    }

    /* Allow drawing at a different resolution than the internal texture size */
    resizeCanvas() {
        let canvas = document.getElementById('mapgen4') as HTMLCanvasElement;
        const {width, height} = this.picture; /* could be smaller to increase performance */
        if (canvas.width !== width || canvas.height !== height) {
            console.log(`Resizing canvas from ${canvas.width}x${canvas.height} to ${width}x${height}`);
            canvas.width = width;
            canvas.height = height;
            this.webgl.gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    /* wrapper function to make the other drawing functions more convenient */
    drawGeneric(program: Program, fb: Framebuffer | null, draw: (gl: WebGL2RenderingContext, program: Program) => void) {
        const {gl} = this.webgl;
        fb = fb ?? this.webgl.drawToScreen();
        fb.viewport();
        program.run(() => {
            if (fb.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            draw(gl, program);
            if (fb.depth) gl.disable(gl.DEPTH_TEST);
        });
    }

    drawRivers() {
        this.drawGeneric(this.program_river, this.fbo_river, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.blendEquation(gl.FUNC_ADD);

            gl.drawArrays(gl.TRIANGLES, 0, 3 * this.numRiverTriangles);
        });
    }

    drawLand(outline_water: number) {
        this.drawGeneric(this.program_land, this.fbo_land, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.topdown);
            gl.uniform1f(program.u_outline_water, outline_water);
            this.fbo_river.texture.activate(gl.TEXTURE0, program.u_water);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDepth() {
        this.drawGeneric(this.program_depth, this.fbo_depth, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawDrape(renderParam: any) {
        const light_angle_rad = Math.PI / 180 * (renderParam.light_angle_deg + renderParam.rotate_deg);
        this.drawGeneric(this.program_drape, this.fbo_drape, (gl, program) => {
            gl.uniformMatrix4fv(program.u_projection, false, this.projection);
            gl.uniform2fv(program.u_world, [this.world.width, this.world.height]);
            gl.uniform2fv(program.u_world_inverse, [1 / this.world.width, 1 / this.world.height]);
            gl.uniform2fv(program.u_light_angle, [Math.cos(light_angle_rad), Math.sin(light_angle_rad)]);
            gl.uniform2fv(program.u_inverse_texture_size, [1.5 / this.fbo_drape.texture.width, 1.5 / this.fbo_drape.texture.height]);
            gl.uniform1f(program.u_slope, renderParam.slope);
            gl.uniform1f(program.u_flat, renderParam.flat);
            gl.uniform1f(program.u_ambient, renderParam.ambient);
            gl.uniform1f(program.u_overhead, renderParam.overhead);
            gl.uniform1f(program.u_outline_depth, renderParam.outline_depth * 5 * renderParam.zoom);
            gl.uniform1f(program.u_outline_coast, renderParam.outline_coast);
            gl.uniform1f(program.u_outline_water, renderParam.outline_water);
            gl.uniform1f(program.u_outline_strength, renderParam.outline_strength);
            gl.uniform1f(program.u_outline_threshold, renderParam.outline_threshold / 1000);
            gl.uniform1f(program.u_biome_colors, renderParam.biome_colors);

            this.texture_colormap.activate(gl.TEXTURE0, program.u_colormap);
            this.fbo_land.texture.activate(gl.TEXTURE1, program.u_elevation);
            this.fbo_river.texture.activate(gl.TEXTURE2, program.u_water);
            this.fbo_depth.texture.activate(gl.TEXTURE3, program.u_depth);
            // Unit 4: 0-3 are taken above, and activate() refuses 7 and up.
            gl.uniform1f(program.u_use_colormap3d, this.use_colormap3d);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_3D, this.texture_colormap3d);
            gl.uniform1i(program.u_colormap3d, 4);
            // Unit 5, the tint: a 2D texture, bound directly for the same reason.
            gl.uniform1f(program.u_use_tint, this.use_tint);
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, this.texture_tint.id);
            gl.uniform1i(program.u_tint, 5);
            // Unit 6, the surface; its looks come with the view, and nothing given is nothing drawn.
            gl.uniform1f(program.u_use_surface, this.use_surface);
            gl.activeTexture(gl.TEXTURE6);
            gl.bindTexture(gl.TEXTURE_2D, this.texture_surface.id);
            gl.uniform1i(program.u_surface, 6);
            gl.uniform2fv(program.u_wind, renderParam.surface_wind ?? [1, 0]);
            gl.uniform4fv(program.u_dunes, renderParam.surface_dunes ?? [5, 0, 0, 0]);
            gl.uniform4fv(program.u_trees, renderParam.surface_trees ?? [3.5, 0, 0, 0]);
            gl.uniform4fv(program.u_edge, renderParam.surface_edge ?? [0, 0, 0, 0]);
            // Units 7 to 10, the covers, their ids and palettes: bound directly, as 4 to 6 are.
            gl.uniform1f(program.u_use_cover, this.use_cover);
            gl.uniform1f(program.u_palette_rows, this.palette_rows);
            gl.uniform1f(program.u_lean, renderParam.mountain_height ?? 0);
            const units: [number, Texture, any][] = [[7, this.texture_cover0, program.u_cover0], [8, this.texture_cover1, program.u_cover1],
                [9, this.texture_cover_ids, program.u_cover_ids], [10, this.texture_palette, program.u_palette]];
            for (const [unit, texture, at] of units) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, texture.id);
                gl.uniform1i(at, unit);
            }
            gl.activeTexture(gl.TEXTURE0);

            gl.drawElements(gl.TRIANGLES, this.quad_elements_length, gl.UNSIGNED_INT, 0);
        });
    }

    drawFinal(offset: [number, number]) {
        this.drawGeneric(this.program_final, null, (gl, program) => {
            gl.uniform2fv(program.u_offset, offset);
            this.fbo_drape.texture.activate(gl.TEXTURE0, program.u_texture);

            gl.drawArrays(gl.TRIANGLES, 0, 3);
        });
    }

    startDrawingLoop() {
        const {gl} = this.webgl;

        const clearBuffers = () => {
            this.fbo_river.clear(0, 0, 0, 0);
            this.fbo_depth.clear(0, 0, 0, 1);
            this.fbo_drape.clear(0.3, 0.3, 0.35, 1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        };

        /* Only draw when render parameters have been passed in;
         * otherwise skip the render and wait for the next tick */
        clearBuffers();
        const renderLoop = () => {
            requestAnimationFrame(renderLoop);
            const renderParam = this.renderParam;
            if (!renderParam) { return; }
            this.renderParam = undefined;

            if (this.numRiverTriangles > 0) {
                this.drawRivers();
            }

            this.drawLand(renderParam.outline_water);

            /* Standard rotation for orthographic view */
            mat4.identity(this.projection);
            mat4.rotateX(this.projection, this.projection, (180 + renderParam.tilt_deg) * Math.PI/180);
            mat4.rotateZ(this.projection, this.projection, renderParam.rotate_deg * Math.PI/180);

            /* Top-down oblique copies column 2 (y input) to row 3 (z
             * output). Typical matrix libraries such as glm's mat4 or
             * Unity's Matrix4x4 or Unreal's FMatrix don't have this
             * this.projection built-in. For mapgen4 I merge orthographic
             * (which will *move* part of y-input to z-output) and
             * top-down oblique (which will *copy* y-input to z-output).
             * <https://en.wikipedia.org/wiki/Oblique_projection> */
            this.projection[9] = 1;

            /* Scale and translate works on the hybrid this.projection */
            mat4.scale(this.projection, this.projection, [renderParam.zoom/100, renderParam.zoom/100, renderParam.mountain_height * renderParam.zoom/100]);
            mat4.translate(this.projection, this.projection, [-renderParam.x, -renderParam.y, 0]);

            /* A picture that is not square: stretch the screen's y so a map
             * unit is as tall as it is wide. Last, so the lean of the
             * mountains (row y, column z above) is stretched with it. */
            const aspect = this.picture.width / this.picture.height;
            if (aspect !== 1) {
                mat4.multiply(this.projection, mat4.fromScaling(mat4.create(), [1, aspect, 1]), this.projection);
            }

            /* Keep track of the inverse matrix for mapping mouse to world coordinates */
            mat4.invert(this.inverse_projection, this.projection);

            if (renderParam.outline_depth > 0) {
                this.drawDepth();
            }

            this.drawDrape(renderParam);

            /* Draw the final texture to the canvas; this slightly blurs the outlines */
            this.drawFinal([0.5 / this.picture.width, 0.5 / this.picture.height]);

            if (this.screenshotCallback) {
                const ctx = this.screenshotCanvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height);
                const bytesPerRow = 4 * this.screenshotCanvas.width;
                const buffer = new Uint8Array(bytesPerRow * this.screenshotCanvas.height);
                gl.readPixels(0, 0, this.screenshotCanvas.width, this.screenshotCanvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

                /* Flip row order from WebGL to Canvas */
                for (let y = 0; y < this.screenshotCanvas.height; y++) {
                    const rowBuffer = new Uint8Array(buffer.buffer, y * bytesPerRow, bytesPerRow);
                    imageData.data.set(rowBuffer, (this.screenshotCanvas.height-y-1) * bytesPerRow);
                }
                ctx.putImageData(imageData, 0, 0);

                this.screenshotCallback();
                this.screenshotCallback = null;
            }

            clearBuffers();
        };

        renderLoop();
    }

    updateView(renderParam: any) {
        this.renderParam = renderParam;
    }
}
