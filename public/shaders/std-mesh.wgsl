struct VertexOutput {
    @location(0) @interpolate(flat) normal : vec3<f32>,
    @location(1) @interpolate(flat) color : vec3<f32>,
    @location(2) worldPos: vec4<f32>,
    //@location(3) shadowPos: vec3<f32>,
    @location(3) uv: vec2<f32>,
    @location(4) @interpolate(flat) surface: u32,
    @location(5) @interpolate(flat) id: u32,
    @builtin(position) position : vec4<f32>,
};

fn gerstner(Q: f32, A: f32, D: vec2<f32>, w: f32, phi: f32, uv: vec2<f32>, t: f32) -> vec3<f32> {
    return vec3<f32>(Q * A + D.x * cos(dot(w * D, uv) + phi * t),
                     A * sin(dot(w * D, uv) + phi * t),
                     Q * A + D.y * cos(dot(w * D, uv) + phi * t));
}

@vertex
fn vert_main(input: VertexInput) -> VertexOutput {
    let position = input.position;
    let uv = input.uv;
    let color = input.color;
    let normal = input.normal;
    let tangent = input.tangent;
    let perp = cross(tangent, normal);
    
    
    //let height = sin(uv.x * 100 + scene.time * .001) * ceil(max(uv.x, uv.y)) * 4;
    let isuv = ceil(max(uv.x, uv.y));
    //let displacedPos = position + gerstner(1, 40, vec2<f32>(0, 1), .5, 2, uv * 1000, scene.time * .001) * isuv;
    let flattenedPos = vec3<f32>(uv.x - 1.0, 0, uv.y) * 1000;
    rand_seed = vec2<f32>(-45, 13);
    rand();
    let D0 = normalize(vec2<f32>(rand() - 0.5, rand() - 0.5));
    let D0a = normalize(vec2<f32>(rand() - 0.5, rand() - 0.5));
    let D1 = normalize(vec2<f32>(rand() - 0.5, rand() - 0.5));
    let D2 = normalize(vec2<f32>(rand() - 0.5, rand() - 0.5));
    let gerstnerDisplacement0 = gerstner(1., 5. * 2., D0, .5 / 10.0, 0.5, uv * 1000., scene.time * .001) * isuv;
    let gerstnerDisplacement0a = gerstner(1., 5. * 2., D0a, .5 / 10.0, 0.5, uv * 1000., scene.time * .001) * isuv;
    let gerstnerDisplacement1 = gerstner(1., 2. * 2., D1, .5 / 4.0, 1., uv * 1000., scene.time * .001) * isuv;
    let gerstnerDisplacement2 = gerstner(1., 0.5 * 2., D2, .5 / 1.0, 3., uv * 1000., scene.time * .001) * isuv;    
    //let displacedPos = position + normal * gerstnerDisplacement.y + tangent * gerstnerDisplacement.x + perp * gerstnerDisplacement.z;
    let displacedPos = flattenedPos + gerstnerDisplacement0 + gerstnerDisplacement0a;// gerstnerDisplacement0 + gerstnerDisplacement0a + gerstnerDisplacement1; //+ gerstnerDisplacement2;
    var output : VertexOutput;
    
    let worldPos: vec4<f32> = meshUni.transform * vec4<f32>(displacedPos, 1.0);

    let finalPos = worldPos;

     // XY is in (-1, 1) space, Z is in (0, 1) space
    // let posFromLight = (scene.lightViewProjMatrix * worldPos).xyz;

    // // Convert XY to (0, 1), Y is flipped because texture coords are Y-down.
    // output.shadowPos = vec3<f32>(
    //     posFromLight.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5),
    //     posFromLight.z
    // );

    
    output.worldPos = finalPos;
    output.position = scene.cameraViewProjMatrix * finalPos;
    // TODO: use inverse-transpose matrix for normals as per: https://learnopengl.com/Lighting/Basic-Lighting
    output.normal = normalize(meshUni.transform * vec4<f32>(normal, 0.0)).xyz;
    output.color = color + meshUni.tint;

    // DEBUG TANGENTS
    output.color = input.tangent;
    
    // DEBUG:
    // output.color = vec3<f32>(f32(uvInt.x), f32(uvInt.y), 1.0);
    // output.color = texDisp.rgb;
    // output.color = vec3(uv.xy, 1.0);
    // output.color = input.color;

    output.surface = input.surfaceId;
    output.id = meshUni.id;

    output.uv = uv;

    return output;
}

struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) normal: vec4<f32>,
  // @location(2) position: vec4<f32>,
  @location(2) surface: vec2<u32>,
}

const shadowDepthTextureSize = 1024.0;
// const shadowDepthTextureSize = vec2<f32>(textureDimensions(shadowMap, 0.0));

fn sampleShadowTexture(pos: vec2<f32>, depth: f32, index: u32) -> f32 {
    if (index == 0) {
        return textureSampleCompare(shadowMap0, shadowSampler, pos, depth);
    } else if (index == 1) {
        return textureSampleCompare(shadowMap1, shadowSampler, pos, depth);
    } else {
        return textureSampleCompare(shadowMap2, shadowSampler, pos, depth);
    }
}

fn getShadowVis(shadowPos: vec3<f32>, normal: vec3<f32>, lightDir: vec3<f32>, index: u32) -> f32 {
  // See: https://learnopengl.com/Advanced-Lighting/Shadows/Shadow-Mapping
  // Note: a better bias would look something like "max(0.05 * (1.0 - dot(normal, lightDir)), 0.005);"
    //let shadowBias = 0.007;
    //let shadowBias = 0.001;
    //let shadowBias = max(0.05 * (1.0 - dot(normal, lightDir)), 0.005);
  let shadowBias = 0.0001;
  let shadowDepth = shadowPos.z; // * f32(shadowPos.z <= 1.0);
  let outsideShadow = 1.0 - f32(0.0 < shadowPos.x && shadowPos.x < 1.0 
                && 0.0 < shadowPos.y && shadowPos.y < 1.0);
  //let shadowSamp = sampleShadowTexture(shadowPos.xy, shadowDepth - shadowBias, index);

  //Percentage-closer filtering. Sample texels in the region
  //to smooth the result.
  var visibility : f32 = 0.0;
  let oneOverShadowDepthTextureSize = 1.0 / shadowDepthTextureSize;
  for (var y : i32 = -1 ; y <= 1 ; y = y + 1) {
      for (var x : i32 = -1 ; x <= 1 ; x = x + 1) {
          let offset : vec2<f32> = vec2<f32>(
          f32(x) * oneOverShadowDepthTextureSize,
          f32(y) * oneOverShadowDepthTextureSize);

          visibility = visibility + sampleShadowTexture(shadowPos.xy + offset, shadowDepth - shadowBias, index);
      }
  }
  visibility = visibility / 9.0;
  // var visibility = textureSampleCompare(shadowMap, shadowSampler, 
  //                                       shadowPos.xy, shadowDepth - shadowBias);
 
  visibility = min(outsideShadow + visibility, 1.0);

  return visibility;
}

@fragment
fn frag_main(input: VertexOutput) -> FragOut {
    let normal = normalize(input.normal);
    // let normal = -normalize(cross(dpdx(input.worldPos.xyz), dpdy(input.worldPos.xyz)));


    var lightingColor: vec3<f32> = vec3<f32>(0.0, 0.0, 0.0);
    let unlit = meshUni.flags & 1u >> 0u;
    for (var i: u32 = 0u; i < scene.numPointLights; i++) {
        let light = pointLights.ms[i];
        let toLight = light.position - input.worldPos.xyz;
        let distance = length(toLight);
        let attenuation = 1.0 / (light.constant + light.linear * distance +
                                 light.quadratic * distance * distance);
        let angle = clamp(dot(normalize(toLight), input.normal), 0.0, 1.0);
     // XY is in (-1, 1) space, Z is in (0, 1) space
        let posFromLight = (pointLights.ms[i].viewProj * input.worldPos).xyz;
        
        // Convert XY to (0, 1), Y is flipped because texture coords are Y-down.
        let shadowPos = vec3<f32>(posFromLight.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5),
                                  posFromLight.z
                                  );
        let shadowVis = getShadowVis(shadowPos, input.normal, normalize(toLight), i);
        //lightingColor = lightingColor + clamp(abs((light.ambient * attenuation) + (light.diffuse * angle * attenuation * shadowVis)), vec3(0.0), vec3(1.0));
        //lightingColor += light.ambient;
        lightingColor = lightingColor + f32(1u - unlit) * ((light.ambient * attenuation) + (light.diffuse * angle * attenuation * shadowVis));
    }
    let litColor = input.color * (lightingColor + vec3(f32(unlit)));

    let fogDensity: f32 = 0.02;
    let fogGradient: f32 = 1.5;
    // let fogDist: f32 = 0.1;
    let fogDist: f32 = max(-input.worldPos.y - 10.0, 0.0);
    // output.fogVisibility = 0.9;
    let fogVisibility: f32 = clamp(exp(-pow(fogDist*fogDensity, fogGradient)), 0.0, 1.0);

    let backgroundColor: vec3<f32> = vec3<f32>(0.6, 0.63, 0.6);
    // let backgroundColor: vec3<f32> = vec3<f32>(0.6, 0.63, 0.6);
    // let finalColor: vec3<f32> = mix(backgroundColor, gammaCorrected, fogVisibility);
    // let finalColor: vec3<f32> = gammaCorrected;


    var out: FragOut;
    out.color = vec4<f32>(litColor, 1.0);

    // let t = scene.time * 0.0005;
    // // TODO(@darzu): experimenting with reading from SDF
    // // TODO(@darzu): use sample instead of load
    // let sdf = textureSample(sdf, samp, input.uv);
    // out.color = vec4<f32>(sdf.x * 0.5 + 0.1);
    // if (fract(input.uv.x * 10.0 + t) < 0.1) {
    //   out.color.g += 0.2;
    // }
    // if (fract(input.uv.y * 10.0 + t) < 0.1) {
    //   out.color.r += 0.2;
    // }
    // if (input.uv.x > 0.0 && input.uv.y > 0.0)
    // {
    //   // let xy = vec2<i32>(input.uv * vec2<f32>(textureDimensions(sdf)));
    //   // let t = textureLoad(sdf, xy, 0);
    //   // let d = length(t);
    //   let d = sdf.x;
    //   // if (t.x > 0.0 || t.y > 0.0) {
    //   //   out.color.r = 1.0;
    //   // }
    //   let d2 = fract(d * 10.0 + t);
    //   if (0.0 < d2 && d2 < 0.1 * 4.0) {
    //     out.color.b += 0.2;
    //   }
    //   if (d < 0.01 * 4.0) {
    //     out.color.b += 0.2;
    //   }
    //   // if (d > 0.0) {
    //   //   out.color.r = 1.0;
    //   // }
    // }

    // out.color = vec4<f32>(input.uv, 0.0, 1.0);
    // out.normal = vec4(input.normal, 1.0);
    out.normal = vec4(normalize((scene.cameraViewProjMatrix * vec4<f32>(input.normal, 0.0)).xyz), 1.0);
    // out.position = input.worldPos;
    out.surface.r = input.surface;
    out.surface.g = input.id;
    // out.color = vec4(input.color, 1.0);
    // out.color = input.surface;
    // out.color = vec4(input.shadowPos.xy, 0.0, 1.0);

    return out;
    // return vec4<f32>(finalColor, 1.0);
    // return vec4<f32>(input.color, 1.0);
}
