export const getPlatformVersion = (buildVersion: string | undefined, packageVersion: string) => {
  if (buildVersion) return buildVersion
  return packageVersion
}
