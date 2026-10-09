import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
// @ts-expect-error Native browser module; the decoder has no server dependencies.
import {geohashBounds} from '../public/map.js';

test('geohash6 decodes whole geographic cells, including poles and longitude edges',()=>{
  assert.deepEqual(geohashBounds('000000'),{south:-90,north:-89.9945068359375,west:-180,east:-179.989013671875});
  assert.deepEqual(geohashBounds('zzzzzz'),{south:89.9945068359375,north:90,west:179.989013671875,east:180});
  assert.deepEqual(geohashBounds('u4pruy'),{south:57.645263671875,north:57.6507568359375,west:10.404052734375,east:10.4150390625});
  for(const value of [null,undefined,'','u4pru','u4pruyx','U4PRUY','iiiiii','<svg/>'])assert.equal(geohashBounds(value),null);
});

class Element {
  children:Element[]=[];attributes:Record<string,string>={};textContent='';className='';
  readonly tag:string;
  constructor(tag:string){this.tag=tag;}
  append(...children:Element[]){this.children.push(...children);}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
  get text():string{return this.textContent+this.children.map(child=>child.text).join(' ');}
}
test('area map renders unverified regions, not points, and handles absent or invalid locations',()=>{
  const code=readFileSync(new URL('../public/map.js',import.meta.url),'utf8').replaceAll('export function','function');
  const render=runInNewContext(code+'\ndeclaredAreaMap',{document:{createElement:(tag:string)=>new Element(tag),createElementNS:(_namespace:string,tag:string)=>new Element(tag)}}) as (hash:unknown)=>Element;
  for(const hash of ['u4pruy','000000','zzzzzz']){
    const result=render(hash),svg=result.children.find(child=>child.tag==='svg')!;
    assert.ok(svg);assert.match(result.text,/Not independently verified/);assert.match(result.text,/not an exact GPS position/);
    const cell=svg.children.find(child=>child.attributes.class==='map-area')!;assert.equal(cell.tag,'rect');
    for(const key of ['x','y','width','height'])assert.ok(Number.isFinite(Number(cell.attributes[key])));
    assert.ok(Number(cell.attributes.width)>0&&Number(cell.attributes.height)>0);
    assert.ok(!svg.children.some(child=>child.tag==='circle'));assert.match(result.text,new RegExp(hash));
  }
  const missing=render(null);assert.match(missing.text,/No declared location/);assert.ok(!missing.children.some(child=>child.tag==='svg'));
  const invalid=render('broken!');assert.match(invalid.text,/not a valid geohash6/);assert.ok(!invalid.children.some(child=>child.tag==='svg'));
});
