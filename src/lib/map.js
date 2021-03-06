import mapboxgl from 'mapbox-gl';
import store from '../store';
import 'mapbox-gl/dist/mapbox-gl.css';
import {makeImage} from './utils';
import droneIcon from '../images/icon_drone.png';
import locationIcon from '../images/icon_location.png';
import chargingStationIcon from '../images/icon_charging_station.png';
import pickupIcon from '../images/pin-pickup.svg';
import dropoffIcon from '../images/pin-dropoff.svg';
import mapStyle from './map_style.json';
import turf from 'turf';

const icons = {droneIcon, locationIcon, chargingStationIcon, pickupIcon, dropoffIcon};

const createGeoJson = (features = []) => {
  return {
    type: 'FeatureCollection',
    features: features.map(feature => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [feature.long || feature.coords.long, feature.lat || feature.coords.lat],
      },
      properties: {
        id: feature.id,
      },
    })),
  };
};

export const getUserLocation = () =>
  new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      maximumAge: 60000,
      timeout: 50000,
      enableHighAccuracy: false
    }),
  );

export const getUserLocationPlace = () => {
  return hasGeolocationPermission()
    .then(getUserLocation)
    .then((resp) => {
      return new Promise((resolve, reject) => {
        if (window.google && window.google.maps) {
          var geocoder = new window.google.maps.Geocoder();
          geocoder.geocode({
            location: {
              lat: resp.coords.latitude,
              lng: resp.coords.longitude
            }
          }, (results, status) => {
            if (status === 'OK') {
              if (results[0]) {
                resolve(results[0].formatted_address);
              } else {
                reject('Geocoder: No results found');
              }
            } else {
              reject('Geocoder failed due to: ' + status);
            }
          });
        } else {
          reject('Google map api was not found in the page.');
        }
      });
    });
};

/**
 * Returns a promise that resolves only if we can determine that the user has granted geolocation permission
 * Promise rejects if permission wasn't granted, denied, or Permissions API is not supported
 *
 * @returns {Promise}
 */
const hasGeolocationPermission = () =>
  new Promise((resolve, reject) => {
    if (!navigator.permissions) reject();
    navigator.permissions
      .query({name: 'geolocation'})
      .then(result => (result.state === 'granted' ? resolve() : reject()));
  });

export const createMap = ({
  containerId,
  coords,
  onMapItemClick,
  onMoveEnd,
  addControls,
}) => {
  // Add support for right-to-left languages
  mapboxgl.setRTLTextPlugin(
    '/lib/mapbox-gl-rtl-text.js.min',
  );

  // Create the map
  let map = new mapboxgl.Map({
    container: containerId,
    style: mapStyle,
    center: [coords.long, coords.lat],
    zoom: 14,
    attributionControl: false,
  });


  if (addControls) {
    // Add controls to geolocate the user
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: {
          enableHighAccuracy: true,
        },
        trackUserLocation: true,
      }),
      'bottom-left',
    );

    // Add minimal attribution controls
    map.addControl(
      new mapboxgl.AttributionControl({
        compact: true,
      }),
    );
  }

  // add images, sources, and layers on load
  map.on('load', () => {
    Object.keys(icons).forEach((key) => {
      const imgId = key.replace('Icon', '');
      makeImage(icons[key]).then(img => map.addImage(imgId, img));
    });

    map.addSource('vehicles', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.addLayer({
      id: 'vehicles',
      type: 'symbol',
      source: 'vehicles',
      minzoom: 10,
      layout: {
        'icon-image': 'drone',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    map.addSource('chargers', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    map.addLayer({
      id: 'chargers',
      type: 'symbol',
      source: 'chargers',
      minzoom: 10,
      layout: {
        'icon-image': 'charger',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });

    ['vehicles', 'chargers'].forEach((mapItemType) => {
      map.on('click', mapItemType, e =>
        onMapItemClick({id: e.features[0].properties.id, mapItemType: mapItemType}),
      );
    });
  });

  map.on('moveend', () => {
    const mapCenter = map.getCenter();
    onMoveEnd({lat: mapCenter.lat, long: mapCenter.lng});
  });

  // Check if user has already granted permission to access geolocation
  // If permission was granted, get user location and center map on them
  hasGeolocationPermission()
    .then(getUserLocation)
    .then(({coords}) => {
      addUserLocationIcon(map, coords);
      if (store.getState().order.stage === 'draft') {
        return map.setCenter([coords.longitude, coords.latitude]);
      }
    })
    .catch(() => {
    });

  return map;
};

export const updateMap = (map, mapItems = [], mapItemType, {pickup, dropoff, droneLocation}) => {
  handleMapUpdate(map, () => {
    const mapItemTypePlural = `${mapItemType}s`;
    if (mapItems) map.getSource(mapItemTypePlural).setData(createGeoJson(mapItems));
    if (droneLocation) map.getSource('vehicles').setData(createGeoJson([droneLocation]));
    if (pickupAndDropoffPresent(map, pickup, dropoff)) {
      map.getSource('pickup').setData(turf.point([pickup.long, pickup.lat]));
      map.getSource('dropoff').setData(turf.point([dropoff.long, dropoff.lat]));
    }
  });
};


const handleMapUpdate = (map, update) => {
  if (!map.loaded()) {
    map.on('load', update);
  } else {
    update();
  }
};

const pickupAndDropoffPresent = (map, pickup, dropoff) => {
  return (
    pickup && dropoff && map.getSource('pickup') && map.getSource('dropoff')
  );
};

export const initiateZoomTransition = (map, terminals, options) => {
  let collection;
  let features = Object.keys(terminals).map((key) => {
    const terminal = terminals[key];
    return turf.point([terminal.long, terminal.lat]);
  });
  handleMapUpdate(map, () => {
    collection = turf.featureCollection(features);
    let bbox = turf.bbox(collection);
    map.fitBounds(bbox, {...options, padding: {top: 100, bottom: 300, left: 50, right: 50}});
  });
};
export const clearRoute = map => {
  if (map.getSource('route')) {
    map.removeLayer('route');
    map.removeSource('route');
  }
};
export const clearTerminals = map => {
  if (map.getSource('pickup') && map.getSource('dropoff')) {
    map.removeLayer('pickup');
    map.removeLayer('dropoff');
    map.removeSource('pickup');
    map.removeSource('dropoff');
  }
};

export const addRoute = (map, arrayOfTerminals) => {
  arrayOfTerminals = arrayOfTerminals.map((terminal) => {
    return [terminal.long || terminal.coords.long, terminal.lat || terminal.coords.lat];
  });

  if (!map.getSource('route')) {
    map.addLayer({
      'id': 'route',
      'type': 'line',
      'source': {
        'type': 'geojson',
        'data': {
          'type': 'Feature',
          'properties': {},
          'geometry': {
            'type': 'LineString',
            'coordinates': arrayOfTerminals
          }
        }
      },
      'layout': {
        'line-join': 'round',
        'line-cap': 'round'
      },
      'paint': {
        'line-color': '#FF6F4D',
        'line-width': 5
      }
    });
  }
};

const addUserLocationIcon = (map, coords) => {
  if (!map.getSource('location')) {
    map.addSource('location', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      }
    });
  }

  map.addLayer({
    id: 'location',
    type: 'symbol',
    source: 'location',
    minzoom: 10,
    layout: {
      'icon-image': 'location',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.getSource('location').setData(turf.point([coords.longitude, coords.latitude]));
};

export const addTerminals = map => {
  if (!map.getSource('pickup') && !map.getSource('dropoff')) {
    map.addSource('pickup', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.addLayer({
      id: 'pickup',
      type: 'symbol',
      source: 'pickup',
      minzoom: 10,
      layout: {
        'icon-image': 'pickup',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    map.addSource('dropoff', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
    map.addLayer({
      id: 'dropoff',
      type: 'symbol',
      source: 'dropoff',
      minzoom: 10,
      layout: {
        'icon-image': 'dropoff',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }
};

