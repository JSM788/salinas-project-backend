export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

export interface GeofenceEvaluation {
  allowed: boolean;
  bypassed: boolean;
  distanceMeters: number | null;
  radiusMeters: number;
}

/**
 * Validación de geocerca de 50 metros para el check-in de visitas (Haversine).
 *
 * ACTIVADA (`true`) PARA PRUEBAS EN CAMPO REALES:
 * - Si un cliente no tiene coordenadas GPS (`latitude`/`longitude` en `null`),
 *   el check-in pasa por compatibilidad (`bypassed: true`).
 * - NOTA PARA DESARROLLO: Si necesitas volver a testear desde oficina o emulador
 *   sin estar a 50 m del cliente, cambia temporalmente esta bandera a `false`.
 */
export const CHECKIN_GEOFENCE_ENABLED = true;
export const CHECKIN_GEOFENCE_RADIUS_METERS = 50;

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle Haversine distance in meters between two coordinates. */
export function haversineDistanceMeters(
  origin: GeoCoordinates,
  target: GeoCoordinates,
): number {
  const dLat = toRadians(target.latitude - origin.latitude);
  const dLng = toRadians(target.longitude - origin.longitude);
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(target.latitude);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Evaluates whether a check-in falls within the 50m customer geofence. */
export function evaluateCheckInGeofence(
  deviceCoords: GeoCoordinates | null | undefined,
  customerCoords: GeoCoordinates | null | undefined,
  enabled: boolean = CHECKIN_GEOFENCE_ENABLED,
  radiusMeters: number = CHECKIN_GEOFENCE_RADIUS_METERS,
): GeofenceEvaluation {
  const distanceMeters =
    deviceCoords && customerCoords
      ? Math.round(haversineDistanceMeters(deviceCoords, customerCoords) * 10) /
        10
      : null;

  if (!enabled) {
    return {
      allowed: true,
      bypassed: true,
      distanceMeters,
      radiusMeters,
    };
  }

  if (!deviceCoords || distanceMeters === null) {
    return {
      allowed: false,
      bypassed: false,
      distanceMeters,
      radiusMeters,
    };
  }

  return {
    allowed: distanceMeters <= radiusMeters,
    bypassed: false,
    distanceMeters,
    radiusMeters,
  };
}

