export const itemKey = Object.freeze({
  login: (site, username, exactHost) => `login:${site}|${String(username).toLowerCase()}${exactHost ? `|${exactHost}` : ""}`,
  onePassword: () => "1password",
});
