import { assert } from "../../test.js";
import { fullQuad } from "../gpu-helper.js";
import { CY, CyTexturePtr, getTexFromAttachment } from "../gpu-registry.js";

// TODO(@darzu): NOISES!
/*
perlin,
    basic noise
simplex, 
billow, 
    abs(perlin)
ridged, 
    1-abs(perlin)
worley,
analytical derivative based alterations,
    creates realistic erosion
    have features change in relation to different octaves of noise
    knowing the slope at a point helps you distribute features much better (e.g. erosion, rivers)
domain warping,
    feeding noise into itself
    (looks super cool!)

https://www.redblobgames.com/articles/noise/2d/#spectrum
https://simblob.blogspot.com/2009/06/noise-in-game-art.html

higher amplitudes with lower frequencies “red noise”
higher amplitudes with higher frequencies “blue noise”

noise pack:
  https://simon-thommes.com/procedural-noise-pack
*/

const whiteNoiseSizes = [2, 4, 8, 16, 32, 64, 128, 256, 512] as const;
export const whiteNoiseTexs = whiteNoiseSizes.map((s) =>
  CY.createTexture(`whiteNoise${s}Tex`, {
    size: [s, s],
    format: "r32float",
  })
);

export const whiteNoisePipes = whiteNoiseSizes.map((s, i) => {
  return CY.createRenderPipeline(`whiteNoise${s}Pipe`, {
    globals: [{ ptr: fullQuad, alias: "quad" }],
    output: [whiteNoiseTexs[i]],
    meshOpt: {
      stepMode: "single-draw",
      vertexCount: 6,
    },
    shaderVertexEntry: "vert_main",
    shaderFragmentEntry: "frag_main",
    shader: (shaders) => `
  ${shaders["std-rand"].code}
  ${shaders["std-screen-quad-vert"].code}

  @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) f32 {
      rand_seed = uv;
      return rand();
    }
  `,
  });
});

// random vector fields, used for gradient noises
export const vecNoiseTexs = whiteNoiseSizes.map((s) =>
  CY.createTexture(`vecNoise${s}Tex`, {
    size: [s, s],
    format: "rg32float",
  })
);
export const vecNoisePipes = whiteNoiseSizes.map((s, i) => {
  return CY.createRenderPipeline(`vecNoise${s}Pipe`, {
    globals: [{ ptr: fullQuad, alias: "quad" }],
    output: [vecNoiseTexs[i]],
    meshOpt: {
      stepMode: "single-draw",
      vertexCount: 6,
    },
    shaderVertexEntry: "vert_main",
    shaderFragmentEntry: "frag_main",
    shader: (shaders) => `
  ${shaders["std-rand"].code}
  ${shaders["std-screen-quad-vert"].code}

  @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec2<f32> {
      rand_seed = uv;
      let n = rand();
      return vec2(cos(n),sin(n));
    }
  `,
  });
});

const octavesPipe1 = createOctaveNoisePipe([3, 5, 7], 2);
const octavesPipe2 = createOctaveNoisePipe([3], 2);
const octavesPipe3 = createOctaveNoisePipe([1, 2, 3, 4, 5, 6, 7, 8], 2);
const octavesPipe4 = createOctaveNoisePipe([1, 2, 3, 4, 5, 6, 7, 8], 1.2);

function createOctaveNoisePipe(frequencies: number[], persistence: number) {
  // TODO(@darzu): make colorings a parameter?
  assert(
    frequencies.every((f) => Number.isInteger(f)),
    "freqs must be int"
  );
  assert(
    frequencies[frequencies.length - 1] < whiteNoiseSizes.length + 1,
    "freq range"
  );
  // assert(Number.isInteger(persistence), "freqs must be int");

  const name = `octaveNoise_${frequencies.join("_")}by${persistence}`;

  const octaveNoiseTex = CY.createTexture(name + "Tex", {
    size: [128, 128],
    format: "r32float",
  });

  const smooth = true;

  return CY.createRenderPipeline(name + "Pipe", {
    globals: [
      {
        ptr: fullQuad,
        alias: "quad",
      },
      ...whiteNoiseTexs.map((t) => t),
    ],
    output: [octaveNoiseTex],
    meshOpt: {
      stepMode: "single-draw",
      vertexCount: 6,
    },
    shaderVertexEntry: "vert_main",
    shaderFragmentEntry: "frag_main",
    shader: (shaders) => `
    ${shaders["std-rand"].code}
    ${shaders["std-screen-quad-vert"].code}

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) f32 {
        rand_seed = uv;

        var width = 0.0;
        var res = 0.0;
        // try sampling ?
        ${frequencies
          .map((f) => {
            let s = Math.pow(2, f);
            let p = Math.pow(persistence, f);
            return `
            {
              let xyf = uv * vec2<f32>(textureDimensions(whiteNoise${s}Tex));
              let i = vec2<i32>(xyf);
              let _f = fract(xyf);
              let f = smoothstep(vec2(0.),vec2(1.),_f);
              // TODO: just use a sampler?
              ${
                smooth
                  ? `
              let _a = textureLoad(whiteNoise${s}Tex, i + vec2(0,0), 0);
              let _b = textureLoad(whiteNoise${s}Tex, i + vec2(1,0), 0);
              let _c = textureLoad(whiteNoise${s}Tex, i + vec2(0,1), 0);
              let _d = textureLoad(whiteNoise${s}Tex, i + vec2(1,1), 0);
              let a = _a.x;
              let b = _b.x;
              let c = _c.x;
              let d = _d.x;
              let s = mix(
                  mix(a, b, f.x),
                  mix(c, d, f.x),
                  f.y);
              `
                  : `
              let s = textureLoad(whiteNoise${s}Tex, i, 0).x;
              `
              }
              let w = 1.0 / ${p.toFixed(2)};
              res += s * w;
              width += w;
            }
            `;
          })
          .join("\n")}
        
        return res / width;
      }
    `,
  });
}

// TODO(@darzu): IMPL PERLIN
/* https://thebookofshaders.com/11/
  smoothstep on GPU
  float i = floor(x);  // integer
  float f = fract(x);  // fraction
  y = mix(rand(i), rand(i + 1.0), smoothstep(0.,1.,f));
*/

export const perlinNoiseTex = CY.createTexture("perlinNoiseTex", {
  size: [128, 128],
  format: "r32float",
});

export const perlinNoisePipe = CY.createRenderPipeline("perlinNoisePipe", {
  globals: [{ ptr: fullQuad, alias: "quad" }],
  output: [perlinNoiseTex],
  meshOpt: {
    stepMode: "single-draw",
    vertexCount: 6,
  },
  shaderVertexEntry: "vert_main",
  shaderFragmentEntry: "frag_main",
  shader: (shaders) => `
  ${shaders["std-rand"].code}
  ${shaders["std-screen-quad-vert"].code}

  @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) f32 {
      rand_seed = uv;
      return rand();
    }
  `,
});

export const noisePipes = [
  ...whiteNoisePipes,
  ...vecNoisePipes,
  octavesPipe1,
  octavesPipe2,
  octavesPipe3,
  octavesPipe4,
];

export const noiseGridFrame = [
  [vecNoiseTexs[0], vecNoiseTexs[4]],
  [
    getTexFromAttachment(octavesPipe1.output[0]),
    getTexFromAttachment(octavesPipe2.output[0]),
  ],
  // [
  //   getTexFromAttachment(octavesPipe3.output[0]),
  //   getTexFromAttachment(octavesPipe4.output[0]),
  // ],
] as const;
