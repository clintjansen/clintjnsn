import Delaunator from 'delaunator';

export const MOTION_DURATION = 4600;
export const MOTION_FPS = 24;
export const MOTION_FRAME_COUNT = Math.round(MOTION_DURATION * MOTION_FPS / 1000) + 1;

// Each row follows the same facial features: crown; hairline; temples;
// brows; eyes; nose; lips; jaw; ear; neck; collar; sternum; shoulders.
// Coordinates are authored in each 724 × 543 atlas tile, then normalized.
const ATLAS_LANDMARKS = [
  [[360,20],[270,62],[344,55],[448,99],[242,122],[506,141],[236,146],[277,142],[309,130],[386,122],[239,162],[252,160],[269,161],[309,150],[335,145],[361,148],[289,170],[264,196],[247,202],[296,202],[249,237],[285,225],[331,228],[284,247],[251,284],[315,327],[436,292],[485,190],[309,338],[495,322],[270,403],[540,389],[429,479],[107,465],[649,461]],
  [[365,20],[274,67],[365,57],[470,94],[238,130],[518,145],[239,154],[279,149],[312,133],[395,126],[241,176],[255,173],[274,174],[316,159],[344,155],[373,158],[292,181],[285,210],[266,215],[314,214],[256,259],[303,241],[354,248],[303,272],[258,297],[327,345],[453,300],[500,202],[327,352],[507,335],[277,407],[546,388],[431,480],[107,465],[649,461]],
  [[365,20],[291,65],[370,58],[463,93],[250,123],[493,150],[256,148],[308,145],[339,142],[417,142],[259,173],[279,169],[307,169],[346,159],[376,155],[407,159],[325,185],[310,206],[290,211],[338,212],[283,253],[335,238],[397,240],[338,270],[276,290],[353,340],[456,288],[488,206],[328,352],[492,336],[281,409],[548,396],[432,481],[107,465],[649,461]],
  [[368,20],[296,60],[370,54],[458,74],[253,137],[488,135],[269,144],[329,141],[381,141],[457,144],[272,175],[300,169],[332,173],[381,173],[410,169],[442,174],[357,191],[357,215],[333,223],[383,223],[304,259],[359,245],[425,258],[363,286],[273,300],[364,354],[463,300],[487,210],[305,357],[476,357],[260,423],[535,407],[420,486],[107,465],[649,461]],
];

const BOUNDARY = [[0,0],[.25,0],[.5,0],[.75,0],[1,0],[1,.25],[1,.5],[1,.75],[1,1],[.75,1],[.5,1],[.25,1],[0,1],[0,.75],[0,.5],[0,.25]];
const STOPS = [0, .3, .65, 1];
const smooth = t => t * t * (3 - 2 * t);

function canvas(width, height) {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function meshPoints(points, width, height) {
  return [...points, ...BOUNDARY].map(([x, y]) => [x * width, y * height]);
}

export class PortraitMotion {
  constructor(atlas, width, height) {
    this.width = width;
    this.height = height;
    this.images = [];
    this.points = [];
    const tileWidth = atlas.naturalWidth / 2;
    const tileHeight = atlas.naturalHeight / 2;
    const cropWidth = tileHeight * width / height;
    const cropX = (tileWidth - cropWidth) / 2;
    for (let i = 0; i < 4; i++) {
      const tile = canvas(width, height);
      tile.getContext('2d').drawImage(atlas, i % 2 * tileWidth + cropX, Math.floor(i / 2) * tileHeight, cropWidth, tileHeight, 0, 0, width, height);
      this.images.push(tile);
      const points = ATLAS_LANDMARKS[i].map(([x, y]) => [((x / 724) * tileWidth - cropX) / cropWidth, y / 543]);
      this.points.push(meshPoints(points, width, height));
    }
    this.triangles = this.points.slice(1).map((points, index) => {
      const mean = points.map(([x,y], i) => [(x + this.points[index][i][0]) / 2, (y + this.points[index][i][1]) / 2]);
      return Delaunator.from(mean).triangles;
    });
    this.layers = [canvas(width, height), canvas(width, height)];
    this.contexts = this.layers.map(layer => layer.getContext('2d'));
  }

  draw(context, progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (p === 0 || p === 1) { context.drawImage(this.images[p === 0 ? 0 : this.images.length - 1], 0, 0); return; }
    let segment = 0;
    while (segment < STOPS.length - 2 && p > STOPS[segment + 1]) segment++;
    const mix = smooth((p - STOPS[segment]) / (STOPS[segment + 1] - STOPS[segment]));
    const a = this.points[segment];
    const b = this.points[segment + 1];
    const intermediate = a.map(([x,y], i) => [x + (b[i][0] - x) * mix, y + (b[i][1] - y) * mix]);
    this.warp(this.contexts[0], this.images[segment], a, intermediate, this.triangles[segment]);
    this.warp(this.contexts[1], this.images[segment + 1], b, intermediate, this.triangles[segment]);
    context.drawImage(this.layers[0], 0, 0);
    context.save();
    context.globalAlpha = mix;
    context.drawImage(this.layers[1], 0, 0);
    context.restore();
  }

  warp(context, image, source, destination, triangles) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, this.width, this.height);
    for (let i = 0; i < triangles.length; i += 3) {
      const s = [source[triangles[i]], source[triangles[i+1]], source[triangles[i+2]]];
      const d = [destination[triangles[i]], destination[triangles[i+1]], destination[triangles[i+2]]];
      const sx1 = s[1][0] - s[0][0], sy1 = s[1][1] - s[0][1];
      const sx2 = s[2][0] - s[0][0], sy2 = s[2][1] - s[0][1];
      const dx1 = d[1][0] - d[0][0], dy1 = d[1][1] - d[0][1];
      const dx2 = d[2][0] - d[0][0], dy2 = d[2][1] - d[0][1];
      const determinant = sx1 * sy2 - sx2 * sy1;
      if (Math.abs(determinant) < .001) continue;
      const a = (dx1 * sy2 - dx2 * sy1) / determinant;
      const b = (dy1 * sy2 - dy2 * sy1) / determinant;
      const c = (dx2 * sx1 - dx1 * sx2) / determinant;
      const f = (dy2 * sx1 - dy1 * sx2) / determinant;
      const center = [(d[0][0] + d[1][0] + d[2][0]) / 3, (d[0][1] + d[1][1] + d[2][1]) / 3];
      context.save();
      context.beginPath();
      d.forEach(([x,y], vertex) => {
        const distance = Math.hypot(x - center[0], y - center[1]) || 1;
        const point = [x + (x - center[0]) / distance * .45, y + (y - center[1]) / distance * .45];
        if (vertex === 0) context.moveTo(...point); else context.lineTo(...point);
      });
      context.closePath();
      context.clip();
      context.setTransform(a, b, c, f, d[0][0] - a*s[0][0] - c*s[0][1], d[0][1] - b*s[0][0] - f*s[0][1]);
      context.drawImage(image, 0, 0);
      context.restore();
    }
  }
}
