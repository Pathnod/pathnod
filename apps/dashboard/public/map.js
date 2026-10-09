const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';

// Geohash6 contains 15 longitude and 15 latitude bits: decode the whole cell,
// never present its center as an observed or verified device position.
export function geohashBounds(value) {
  if (typeof value !== 'string' || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{6}$/.test(value)) return null;
  const latitude = [-90, 90], longitude = [-180, 180];
  let isLongitude = true;
  for (const character of value) {
    const bits = alphabet.indexOf(character);
    for (let mask = 16; mask; mask >>= 1) {
      const range = isLongitude ? longitude : latitude;
      range[bits & mask ? 0 : 1] = (range[0] + range[1]) / 2;
      isLongitude = !isLongitude;
    }
  }
  return { south: latitude[0], north: latitude[1], west: longitude[0], east: longitude[1] };
}

export function declaredAreaMap(value) {
  const element = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const section = element('section', undefined, 'declared-map');
  section.append(element('h3', 'Declared location'));
  const bounds = geohashBounds(value);
  if (!bounds) {
    section.append(element('p', value == null || value === '' ?
      'No declared location. There is no area to show on the map.' :
      'The declared location is not a valid geohash6. No area is plotted.', 'note'));
    return section;
  }
  section.append(element('p', 'Operator-provided area · Not independently verified. This rectangle is a region, not an exact GPS position.', 'note'));
  const width = bounds.east - bounds.west, height = bounds.north - bounds.south;
  const west = Math.max(-180, bounds.west - width * 2), east = Math.min(180, bounds.east + width * 2);
  const south = Math.max(-90, bounds.south - height * 2), north = Math.min(90, bounds.north + height * 2);
  const x = longitude => 65 + (longitude - west) / (east - west) * 480;
  const y = latitude => 25 + (north - latitude) / (north - south) * 235;
  const shape = (tag, attributes, text) => {
    const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const svg = shape('svg', {viewBox: '0 0 620 310', role: 'img', 'aria-label': `Declared geohash ${value} area on a latitude and longitude grid; not verified`, class: 'area-grid'});
  svg.append(shape('title', {}, `Declared area ${value} — operator metadata, not verified`));
  svg.append(shape('rect', {x:65, y:25, width:480, height:235, class:'map-background'}));
  for (let step = 0; step <= 4; step++) {
    const longitude = west + (east - west) * step / 4, latitude = south + (north - south) * step / 4;
    svg.append(shape('line', {x1:x(longitude), x2:x(longitude), y1:25, y2:260, class:'map-gridline'}));
    svg.append(shape('line', {x1:65, x2:545, y1:y(latitude), y2:y(latitude), class:'map-gridline'}));
    svg.append(shape('text', {x:x(longitude), y:280, 'text-anchor':'middle'}, longitude.toFixed(4)));
    svg.append(shape('text', {x:57, y:y(latitude)+4, 'text-anchor':'end'}, latitude.toFixed(4)));
  }
  svg.append(shape('rect', {x:x(bounds.west), y:y(bounds.north), width:x(bounds.east)-x(bounds.west), height:y(bounds.south)-y(bounds.north), class:'map-area'}));
  svg.append(shape('text', {x:305, y:303, 'text-anchor':'middle'}, 'Longitude (°)'));
  svg.append(shape('text', {x:582, y:45, 'text-anchor':'middle'}, 'N ↑'));
  section.append(svg, element('p', 'Shaded rectangle: declared area. North is up. Local coordinate map; roads and satellite imagery are not loaded.', 'note'));
  const technical = element('details', undefined, 'technical');
  technical.append(element('summary', 'Geographic details'), element('code', `Geohash6: ${value}`),
    element('code', `Latitude: ${bounds.south.toFixed(6)}° to ${bounds.north.toFixed(6)}°`),
    element('code', `Longitude: ${bounds.west.toFixed(6)}° to ${bounds.east.toFixed(6)}°`));
  section.append(technical);
  return section;
}
