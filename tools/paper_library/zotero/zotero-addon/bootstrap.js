var PaperLibraryWeb;
async function startup({rootURI}) {
  await Zotero.initializationPromise;
  for (const name of ['IOUtils','PathUtils','URL','TextEncoder','TextDecoder','crypto']) {
    try { ChromeUtils.importGlobalProperties([name]); } catch (error) { /* Already supplied by the host, or checked on use. */ }
  }
  Services.scriptloader.loadSubScript(rootURI + 'core.js');
  Services.scriptloader.loadSubScript(rootURI + 'translation.js');
  Services.scriptloader.loadSubScript(rootURI + 'bridge.js');
  await PaperLibraryWeb.startup();
}
function shutdown() { if (PaperLibraryWeb) PaperLibraryWeb.shutdown(); }
function install() {}
function uninstall() {}
