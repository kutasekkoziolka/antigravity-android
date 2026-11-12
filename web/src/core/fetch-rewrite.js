/**
 * core/fetch-rewrite.js - file:// WebView -> core origin fetch rewrite.
 *
 * The WebView loads from file:///android_asset/web/, so main.js builds its
 * transport from window.location.origin ("file://") and the Connect/grpc-web
 * transport then fetches e.g.
 *   file://exa.language_server_pb.languageserverservice/Method
 * which the WebView rejects: URL scheme "file" is not supported.
 *
 * Rewrite file:// or relative ConnectRPC URLs onto the core origin, preserving
 * method/headers/body and attaching the CSRF token. Idempotent and a no-op for
 * non-RPC / already-absolute http(s) URLs.
 *
 * The original periodic HEAD ping is not ported (it referenced an undefined
 * helper; see docs/DEADCODE.md).
 */
var RPC_MARKERS = ['exa.language_server_pb.', 'exa.host_bridge_pb.', '/exa.'];

// RPC path (no leading slash) when `url` is a file:// or relative ConnectRPC
// URL; null for anything else (http(s), blob, data, static assets).
function rpcPathFrom(url) {
  if (!url) return null;
  var s = String(url);
  if (/^(https?|blob|data|wss?|chrome-extension):/i.test(s)) return null;
  var best = -1;
  for (var i = 0; i < RPC_MARKERS.length; i++) {
    var at = s.indexOf(RPC_MARKERS[i]);
    if (at >= 0 && (best === -1 || at < best)) best = at;
  }
  if (best === -1) return null;
  return s.slice(best).replace(/^\/+/, '') || null;
}

function installFetchRewrite() {
  if (global.__AG_FETCH_REWRITE__ || typeof global.fetch !== 'function') return;
  var origFetch = global.fetch.bind(global);

  function fetchWithStartupRetry(u, opts, retries) {
    return origFetch(u, opts).catch(function (err) {
      if (retries > 0) {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(fetchWithStartupRetry(u, opts, retries - 1));
          }, 120);
        });
      }
      throw err;
    });
  }

  global.fetch = function (resource, init) {
    try {
      // Request object: rebuild against the core origin, keep method/body.
      if (resource && typeof resource === 'object' && typeof resource.url === 'string') {
        var rpath = rpcPathFrom(resource.url);
        if (rpath) {
          try {
            var targetUrl = appendCsrfQuery(coreBase() + '/' + rpath);
            var reqMethod = resource.method || (init && init.method) || 'POST';
            var reqHeaders = new Headers(resource.headers || (init && init.headers) || {});
            ensureCsrf(reqHeaders);

            var bodyPromise;
            if (init && init.body !== undefined) {
              bodyPromise = Promise.resolve(init.body);
            } else {
              try {
                bodyPromise = resource.clone().arrayBuffer().then(function (buf) {
                  return buf.byteLength > 0 ? buf : undefined;
                }).catch(function () { return undefined; });
              } catch (e) {
                bodyPromise = Promise.resolve(undefined);
              }
            }

            return bodyPromise.then(function (bodyData) {
              var nextOpts = {
                method: reqMethod,
                headers: reqHeaders,
                body: bodyData,
                credentials: 'omit'
              };
              return fetchWithStartupRetry(targetUrl, nextOpts, 30);
            });
          } catch (e) { warn('fetch rewrite (Request)', e); }
        }
        return origFetch(resource, init);
      }

      // String URL: the Connect/grpc-web transport's common path.
      if (typeof resource === 'string') {
        var path = rpcPathFrom(resource);
        if (path) {
          var url = appendCsrfQuery(coreBase() + '/' + path);
          var headers = new Headers((init && init.headers) || {});
          ensureCsrf(headers);
          var next = {};
          if (init) {
            for (var k in init) {
              if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
            }
          }
          next.headers = headers;

          return fetchWithStartupRetry(url, next, 30);
        }
      }
    } catch (e) { warn('fetch rewrite', e); }
    return origFetch(resource, init);
  };
  global.__AG_FETCH_REWRITE__ = true;

  // 探测本地轻量大模型适配网关 (model_adapter_gateway.py) 是否存活并就绪
  // 仅在本地网关实际监听并返回健康检查 (HTTP 200) 时，才通过 SetCloudCodeURL 进行挂接，
  // 避免在未运行网关时将 Google Cloud Code 核心请求错误重定向至 50999 导致 Connection Refused。
  function configureModelGateway(attempt) {
    try {
      var gatewayPort = 50999;
      var targetUrl = 'http://127.0.0.1:' + gatewayPort;
      var gatewayHealthy = false;
      try {
        gatewayHealthy = !!(global.Android
          && typeof global.Android.isModelGatewayHealthy === 'function'
          && global.Android.isModelGatewayHealthy());
      } catch (probeError) {
        log('native model gateway health probe failed: ' + (probeError && probeError.message ? probeError.message : probeError));
      }

      // CoreServerService starts the gateway asynchronously. Retry briefly so
      // the WebView does not race its startup and permanently keep Google URLs.
      if (!gatewayHealthy) {
        if (attempt < 20) {
          setTimeout(function () { configureModelGateway(attempt + 1); }, 250);
        } else {
          log('model gateway not active, keeping default cloud code endpoint');
        }
        return;
      }

      var rpcUrl = appendCsrfQuery(coreBase() + '/exa.language_server_pb.LanguageServerService/SetCloudCodeURL');
      var reqHeaders = new Headers({
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      });
      ensureCsrf(reqHeaders);
      fetchWithStartupRetry(rpcUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({ url: targetUrl })
      }, 5).then(function (rpcRes) {
        if (rpcRes && rpcRes.ok) {
          log('model gateway verified and connected to ' + targetUrl);
        } else {
          log('model gateway is healthy, but Cloud Code URL setup failed');
        }
      }).catch(function (err) {
        log('model gateway is healthy, but Cloud Code URL setup failed: ' + (err && err.message ? err.message : err));
      });
    } catch (e) {
      warn('model gateway init', e);
    }
  }

  setTimeout(function () { configureModelGateway(0); }, 1500);
}

installFetchRewrite();
