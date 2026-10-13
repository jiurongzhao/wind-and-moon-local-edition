# -*- coding: utf-8 -*-
"""gh-device-login.py —— GitHub 设备码登录（带网络重试）。

gh auth login --web 在这台机器上老被网络抖动打断：轮询期间一次 TLS 失败
就整个退出，前面的授权全废。这个脚本做同一件事，但轮询永不放弃——
网络错误就重试，直到设备码真的过期为止。成功后直接写 gh 的原生配置。

  python3 tools/gh-device-login.py
"""
import json, os, sys, time, urllib.parse, urllib.request

CLIENT_ID = '178c6fc778ccc68e1d6a'   # GitHub CLI 的公开 OAuth client id
SCOPE = 'repo read:org gist workflow'
API = 'https://api.github.com'


def post(url, data):
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(data).encode(),
        headers={'Accept': 'application/json', 'User-Agent': 'fy-device-login'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def main():
    d = post('https://github.com/login/device/code', {'client_id': CLIENT_ID, 'scope': SCOPE})
    dev = d['device_code']
    print('CODE: %s' % d['user_code'], flush=True)
    print('URL : %s' % d.get('verification_uri', 'https://github.com/login/device'), flush=True)
    interval = max(5, int(d.get('interval', 5)))
    expires = time.time() + int(d.get('expires_in', 900))
    while time.time() < expires:
        time.sleep(interval)
        try:
            r = post('https://github.com/login/oauth/access_token', {
                'client_id': CLIENT_ID, 'device_code': dev,
                'grant_type': 'urn:ietf:params:oauth:grant-type:device_code'})
        except Exception as e:
            print('  网络抖动，重试：%s' % str(e)[:80], flush=True)
            continue
        err = r.get('error')
        if err == 'authorization_pending':
            continue
        if err == 'slow_down':
            interval += 5
            continue
        if err:
            print('FAILED: %s %s' % (err, r.get('error_description', '')), flush=True)
            return 1
        tok = r.get('access_token')
        if not tok:
            continue
        req = urllib.request.Request(API + '/user', headers={'Authorization': 'Bearer ' + tok,
                                                             'User-Agent': 'fy-device-login'})
        user = json.loads(urllib.request.urlopen(req, timeout=30).read()).get('login', '')
        cfg = os.path.expanduser('~/.config/gh')
        os.makedirs(cfg, exist_ok=True)
        path = os.path.join(cfg, 'hosts.yml')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('github.com:\n    oauth_token: %s\n    user: %s\n    git_protocol: https\n'
                    % (tok, user))
        os.chmod(path, 0o600)
        print('DONE: 已登录为 %s' % user, flush=True)
        return 0
    print('设备码过期了，重新跑一次', flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
