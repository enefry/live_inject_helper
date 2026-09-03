let uid = JSON.parse(localStorage.getItem("xDeviceInfo")).ui;
if (uid != "0") {
  return { status: 'ready' };
}

return {
  status: 'needsConfiguration',
  reason: 'loginRequired',
  message: 'PandaLive login is required'
};
