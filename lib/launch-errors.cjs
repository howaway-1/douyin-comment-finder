'use strict';

// Browser logs may contain profile paths, account names, or command-line values.
// Classify locally, but return only fixed, actionable messages to the UI.
function errorText(error, seen = new Set(), depth = 0) {
  if (error == null || depth > 5) return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || seen.has(error)) return '';
  seen.add(error);
  return [
    typeof error.code === 'string' ? error.code : '',
    typeof error.message === 'string' ? error.message : '',
    errorText(error.cause, seen, depth + 1),
    ...(Array.isArray(error.errors) ? error.errors.slice(0, 20).map(item => errorText(item, seen, depth + 1)) : []),
  ].join('\n');
}

function describeLaunchError(error) {
  const details = errorText(error);
  // Permission errors must win even if a fallback browser is also missing.
  if (/\b(?:EPERM|EACCES)\b|permission denied|access (?:is )?denied|operation not permitted|拒绝访问|权限不足/i.test(details)) {
    return {
      code: 'BROWSER_PERMISSION_DENIED',
      message: '浏览器启动被系统权限或运行环境限制阻止。',
      action: '请关闭工具服务后，通过 Start.cmd 重新启动；如仍失败，请检查是否允许本地服务启动浏览器子进程。',
    };
  }
  if (/user data directory is already in use|(?:user[- ]data[- ]dir|profile).{0,100}(?:already in use|locked|lock conflict)|ProcessSingleton|SingletonLock|failed to create a process singleton|正在使用.*(?:用户数据|配置文件)|(?:用户数据目录|配置文件).*正在使用/i.test(details)) {
    return {
      code: 'BROWSER_PROFILE_IN_USE',
      message: '检索浏览器的配置目录正被另一个进程占用。',
      action: '请关闭其他检索浏览器窗口和重复运行的工具服务，再重新启动。',
    };
  }
  if (/\bENOENT\b|executable doesn't exist|executable (?:does not exist|not found)|(?:browser|chromium|chrome|msedge).{0,100}(?:not found|not installed|does not exist)|could not find (?:a |the )?(?:browser|chromium|chrome|msedge)|无法找到.*(?:浏览器|可执行文件)/i.test(details)) {
    return {
      code: 'BROWSER_NOT_INSTALLED',
      message: '未找到可启动的浏览器程序。',
      action: '请安装 Chrome 或 Edge，或在工具目录运行 npx playwright install chromium，然后重试。',
    };
  }
  return {
    code: 'BROWSER_LAUNCH_FAILED',
    message: '浏览器启动失败，尚未开始检查评论。',
    action: '请关闭检索浏览器后重新启动工具；如仍失败，请检查本地启动日志中的浏览器错误。',
  };
}

module.exports = {describeLaunchError};
