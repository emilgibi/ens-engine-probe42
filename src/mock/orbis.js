export function getOrbisData(orgName, orgIdentifier) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const updatedOrgData = {
        orgName,
        orgIdentifier,
        BvDId: '12345',
      };
      resolve(updatedOrgData);
    }, 2000);
  });
}
