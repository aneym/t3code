export const CONNECTOR_UNIT_PATH_ENV = "T3CODE_CONNECTOR_UNIT_PATH";

export const serviceUnitFileName = (unitPath: string) =>
  unitPath.slice(unitPath.lastIndexOf("/") + 1);

export function connectorUnitPath(unitPath: string): string {
  return unitPath.replace(/(\.service\.plist|\.plist|\.service)$/, "-connector$1");
}
