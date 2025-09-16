'use strict';

// Web Worker for advanced image enhancement
// Receives: { type: 'process', width, height, data: Uint8ClampedArray, params: {...} }
// Posts progress via { type: 'progress', p, text } and result via { type: 'done', data }

self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.type === 'process') {
    try {
      const { width, height, data, params } = msg;
      postProgress(5, 'Preparing...');
      const out = new Uint8ClampedArray(data); // copy

      // Color space
      const useLinear = params.colorSpace === 'linear';
      if (useLinear) toLinear(out);

      // CLAHE (adaptive contrast)
      if (params.clahe && params.clahe > 0.01) {
        postProgress(20, 'Adaptive contrast...');
        clahe(out, width, height, Math.max(2, Math.round(8 * params.clahe)), 128);
      }

      // Bilateral filter denoise
      if (params.bilateral && params.bilateral > 0.001) {
        postProgress(45, 'Bilateral denoise...');
        bilateralFilter(out, width, height, 2, params.bilateral * 25, 12);
      }

      // Core adjustments similar to main thread (exposure/contrast etc.)
      postProgress(60, 'Global tone/color...');
      coreAdjust(out, width, height, params);

      // Unsharp with threshold
      if (params.usharp && params.uthresh !== undefined) {
        postProgress(75, 'Detail enhancement...');
        unsharpThreshold(out, width, height, 1, params.usharp, params.uthresh);
      }

      // Back to sRGB if needed
      if (useLinear) toSRGB(out);

      // Upscale
      let outWidth = width, outHeight = height;
      if (params.upscale === 2) {
        postProgress(88, 'Upscaling 2x...');
        const scaled = resizeHermite(out, width, height, width * 2, height * 2);
        outWidth = width * 2; outHeight = height * 2;
        postMessage({ type: 'done', width: outWidth, height: outHeight, data: scaled }, [scaled.buffer]);
        return;
      }

      postProgress(100, 'Done');
      postMessage({ type: 'done', width: outWidth, height: outHeight, data: out }, [out.buffer]);
    } catch (err) {
      postMessage({ type: 'error', message: err?.message || String(err) });
    }
  }
};

function postProgress(p, text){ postMessage({ type: 'progress', p, text }); }

function toLinear(data){
  for (let i=0;i<data.length;i+=4){
    data[i] = Math.pow(data[i]/255, 2.2)*255;
    data[i+1] = Math.pow(data[i+1]/255, 2.2)*255;
    data[i+2] = Math.pow(data[i+2]/255, 2.2)*255;
  }
}
function toSRGB(data){
  for (let i=0;i<data.length;i+=4){
    data[i] = clamp255(Math.pow(data[i]/255, 1/2.2)*255);
    data[i+1] = clamp255(Math.pow(data[i+1]/255, 1/2.2)*255);
    data[i+2] = clamp255(Math.pow(data[i+2]/255, 1/2.2)*255);
  }
}

function coreAdjust(data, width, height, p){
  const eAdj = (p.exposure||0)*255;
  const cAdj = p.contrast||1;
  for (let i=0;i<data.length;i+=4){
    let r=data[i], g=data[i+1], b=data[i+2];
    r = r*cAdj + eAdj; g = g*cAdj + eAdj; b = b*cAdj + eAdj;
    data[i]=clamp255(r); data[i+1]=clamp255(g); data[i+2]=clamp255(b);
  }
  // Shadows/highlights
  const shadows = p.shadows||1, highlights = p.highlights||1;
  for (let i=0;i<data.length;i+=4){
    const r=data[i], g=data[i+1], b=data[i+2];
    const l = 0.2126*r + 0.7152*g + 0.0722*b;
    const shadowBoost = shadows-1; const highlightReduce = 1-highlights;
    const f = (1 + shadowBoost*(1-l/255)) * (1 - highlightReduce*(l/255));
    data[i]=clamp255(r*f); data[i+1]=clamp255(g*f); data[i+2]=clamp255(b*f);
  }
  // Saturation/vibrance
  const sat = p.saturation||1, vib = p.vibrance||1;
  for (let i=0;i<data.length;i+=4){
    let r=data[i]/255, g=data[i+1]/255, b=data[i+2]/255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b), v=max, d=max-min;
    let s = max===0?0:d/max;
    const vibranceFactor = 1 + (vib-1)*(1-s);
    const sCombined = s*sat*vibranceFactor;
    if (sCombined<=0){ r=g=b=v; }
    else {
      const m=v - sCombined*v;
      let h; if (d===0) h=0; else if (max===r) h=((g-b)/d)%6; else if (max===g) h=(b-r)/d+2; else h=(r-g)/d+4;
      const c=sCombined*v, x=c*(1-Math.abs((h%2)-1));
      let rp=0,gp=0,bp=0;
      if (0<=h&&h<1){rp=c;gp=x;bp=0;} else if (1<=h&&h<2){rp=x;gp=c;bp=0;} else if (2<=h&&h<3){rp=0;gp=c;bp=x;} else if (3<=h&&h<4){rp=0;gp=x;bp=c;} else if (4<=h&&h<5){rp=x;gp=0;bp=c;} else {rp=c;gp=0;bp=x;}
      r=rp+m; g=gp+m; b=bp+m;
    }
    data[i]=clamp255(r*255); data[i+1]=clamp255(g*255); data[i+2]=clamp255(b*255);
  }
}

function clahe(data, width, height, tiles=8, clipLimit=128){
  // Lightweight CLAHE: operate on luminance with tile histograms
  const tileW = Math.ceil(width/tiles), tileH = Math.ceil(height/tiles);
  const L = new Uint8Array(width*height);
  for (let i=0,j=0;i<data.length;i+=4,j++) L[j] = (0.2126*data[i] + 0.7152*data[i+1] + 0.0722*data[i+2])|0;
  const maps = [];
  for (let ty=0; ty<tiles; ty++){
    for (let tx=0; tx<tiles; tx++){
      const hist = new Uint32Array(256);
      const x0=tx*tileW, y0=ty*tileH, x1=Math.min(width, x0+tileW), y1=Math.min(height, y0+tileH);
      for (let y=y0; y<y1; y++){
        for (let x=x0; x<x1; x++) hist[L[y*width+x]]++;
      }
      // Clip
      let excess = 0;
      for (let k=0;k<256;k++) if (hist[k]>clipLimit){excess += hist[k]-clipLimit; hist[k]=clipLimit;}
      const inc = excess/256;
      for (let k=0;k<256;k++) hist[k]+=inc|0;
      // CDF
      const cdf = new Uint8Array(256);
      let cum=0, area=(x1-x0)*(y1-y0);
      for (let k=0;k<256;k++){ cum += hist[k]; cdf[k] = Math.min(255, Math.round(255*cum/area)); }
      maps.push(cdf);
    }
  }
  // Apply with bilinear interpolation of neighboring tile maps
  for (let y=0;y<height;y++){
    const ty = (y+0.5)/tileH - 0.5; const ty0 = Math.max(0, Math.floor(ty)); const ty1 = Math.min(tiles-1, ty0+1); const wy = ty - ty0;
    for (let x=0;x<width;x++){
      const tx = (x+0.5)/tileW - 0.5; const tx0 = Math.max(0, Math.floor(tx)); const tx1 = Math.min(tiles-1, tx0+1); const wx = tx - tx0;
      const i00 = ty0*tiles + tx0, i01 = ty0*tiles + tx1, i10 = ty1*tiles + tx0, i11 = ty1*tiles + tx1;
      const l = L[y*width+x];
      const m00 = maps[i00][l], m01 = maps[i01][l], m10 = maps[i10][l], m11 = maps[i11][l];
      const m0 = m00*(1-wx) + m01*wx; const m1 = m10*(1-wx) + m11*wx; const m = m0*(1-wy) + m1*wy;
      const idx = (y*width + x)*4;
      const r=data[idx], g=data[idx+1], b=data[idx+2];
      const lr = 0.2126*r + 0.7152*g + 0.0722*b;
      const scale = lr>0? m/lr : 1;
      data[idx] = clamp255(r*scale); data[idx+1]=clamp255(g*scale); data[idx+2]=clamp255(b*scale);
    }
  }
}

function bilateralFilter(data, width, height, radius=2, sigmaColor=25, sigmaSpace=12){
  const src = new Uint8ClampedArray(data);
  const gaussSpatial = [];
  for (let dy=-radius; dy<=radius; dy++){
    for (let dx=-radius; dx<=radius; dx++){
      gaussSpatial.push(Math.exp(-(dx*dx+dy*dy)/(2*sigmaSpace*sigmaSpace)));
    }
  }
  for (let y=0;y<height;y++){
    for (let x=0;x<width;x++){
      let sumR=0,sumG=0,sumB=0,sumW=0, k=0;
      const i=(y*width+x)*4; const r0=src[i], g0=src[i+1], b0=src[i+2];
      for (let dy=-radius; dy<=radius; dy++){
        const yy=Math.min(height-1, Math.max(0, y+dy));
        for (let dx=-radius; dx<=radius; dx++,k++){
          const xx=Math.min(width-1, Math.max(0, x+dx));
          const j=(yy*width+xx)*4; const dr=src[j]-r0, dg=src[j+1]-g0, db=src[j+2]-b0;
          const dc=(dr*dr+dg*dg+db*db);
          const w = gaussSpatial[k] * Math.exp(-dc/(2*sigmaColor*sigmaColor));
          sumW += w; sumR += w*src[j]; sumG += w*src[j+1]; sumB += w*src[j+2];
        }
      }
      data[i] = clamp255(sumR/sumW); data[i+1]=clamp255(sumG/sumW); data[i+2]=clamp255(sumB/sumW);
    }
  }
}

function unsharpThreshold(data, width, height, radius=1, amount=0.6, threshold=8){
  const blur = new Uint8ClampedArray(data);
  // Simple box blur
  const r = Math.max(1, radius|0);
  const tmp = new Uint8ClampedArray(blur);
  const pass = (src,dst,w,h,r,hor) => {
    const size=r*2+1, inv=1/size;
    if (hor){
      for (let y=0;y<h;y++){
        let sr=0,sg=0,sb=0;
        for (let k=-r;k<=r;k++){
          const x=Math.min(w-1, Math.max(0,k)); const i=(y*w+x)*4; sr+=src[i]; sg+=src[i+1]; sb+=src[i+2];
        }
        for (let x=0;x<w;x++){
          const i=(y*w+x)*4; dst[i]=(sr*inv)|0; dst[i+1]=(sg*inv)|0; dst[i+2]=(sb*inv)|0;
          const add=(y*w+Math.min(w-1,x+r+1))*4, sub=(y*w+Math.max(0,x-r))*4;
          sr+=src[add]-src[sub]; sg+=src[add+1]-src[sub+1]; sb+=src[add+2]-src[sub+2];
        }
      }
    } else {
      for (let x=0;x<w;x++){
        let sr=0,sg=0,sb=0;
        for (let k=-r;k<=r;k++){
          const y=Math.min(h-1, Math.max(0,k)); const i=(y*w+x)*4; sr+=src[i]; sg+=src[i+1]; sb+=src[i+2];
        }
        for (let y=0;y<h;y++){
          const i=(y*w+x)*4; dst[i]=(sr*inv)|0; dst[i+1]=(sg*inv)|0; dst[i+2]=(sb*inv)|0;
          const add=(Math.min(h-1,y+r+1)*w+x)*4, sub=(Math.max(0,y-r)*w+x)*4;
          sr+=src[add]-src[sub]; sg+=src[add+1]-src[sub+1]; sb+=src[add+2]-src[sub+2];
        }
      }
    }
  };
  pass(blur,tmp,width,height,r,true); tmp.set(blur); pass(tmp,blur,width,height,r,false);
  for (let i=0;i<data.length;i+=4){
    const dr=data[i]-blur[i], dg=data[i+1]-blur[i+1], db=data[i+2]-blur[i+2];
    if (Math.abs(dr)>threshold || Math.abs(dg)>threshold || Math.abs(db)>threshold){
      data[i] = clamp255(data[i] + amount*dr);
      data[i+1] = clamp255(data[i+1] + amount*dg);
      data[i+2] = clamp255(data[i+2] + amount*db);
    }
  }
}

function resizeHermite(src, sw, sh, dw, dh){
  const dst = new Uint8ClampedArray(dw*dh*4);
  const ratioW = sw/dw, ratioH = sh/dh;
  for (let y=0; y<dh; y++){
    const sy = y*ratioH;
    const sy0 = Math.floor(sy);
    for (let x=0; x<dw; x++){
      const sx = x*ratioW;
      const sx0 = Math.floor(sx);
      let r=0,g=0,b=0,a=0, wsum=0;
      for (let yy=-1; yy<=2; yy++){
        const y2 = Math.min(sh-1, Math.max(0, sy0+yy));
        const wy = hermite(sy - (sy0+yy));
        for (let xx=-1; xx<=2; xx++){
          const x2 = Math.min(sw-1, Math.max(0, sx0+xx));
          const wx = hermite(sx - (sx0+xx));
          const w = wx*wy;
          const i=(y2*sw+x2)*4;
          r += w*src[i]; g += w*src[i+1]; b += w*src[i+2]; a += w*255; wsum += w;
        }
      }
      const j=(y*dw+x)*4; dst[j]=clamp255(r/wsum); dst[j+1]=clamp255(g/wsum); dst[j+2]=clamp255(b/wsum); dst[j+3]=255;
    }
  }
  return dst;
}
function hermite(t){ t=Math.abs(t); if (t<1) return (2*t-3)*t*t+1; if (t<2) return ((-t+5)*t-8)*t+4; return 0; }
function clamp255(v){ return v<0?0:v>255?255:v|0; }


