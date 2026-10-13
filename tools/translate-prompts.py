# -*- coding: utf-8 -*-
"""translate-prompts.py —— 用智谱免费文本模型把出图提示词译成英文（FLUX 吃英文更好）。

读 cards/avatars/prompts.json，给每条补 prompt_en；断点续传（已有 prompt_en 就跳过）。
令牌：~/.image_token 或 ZHIPU_API_KEY。
"""
import concurrent.futures, json, os, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PF = os.path.join(ROOT, 'cards', 'avatars', 'prompts.json')
KEY = open(os.path.expanduser('~/.image_token'), encoding='utf-8').read().strip()
SYS = ('You translate Chinese image-generation prompts into natural English prompts. '
       'Keep all content and every constraint. Output ONLY the translation, '
       'no quotes, no explanation, no markdown.')

def translate(text):
    body = json.dumps({'model': 'glm-4-flash', 'temperature': 0.2,
                       'messages': [{'role': 'system', 'content': SYS},
                                    {'role': 'user', 'content': text}]}).encode()
    req = urllib.request.Request('https://open.bigmodel.cn/api/paas/v4/chat/completions',
                                 data=body, headers={'Content-Type': 'application/json',
                                                     'Authorization': 'Bearer ' + KEY})
    d = json.loads(urllib.request.urlopen(req, timeout=90).read())
    return d['choices'][0]['message']['content'].strip().strip('"')

def main():
    data = json.load(open(PF, encoding='utf-8'))
    items = data['items']
    todo = [i for i in items if not i.get('prompt_en')]
    print('待翻译 %d / %d' % (len(todo), len(items)))
    lock = {'n': 0}

    def work(it):
        for attempt in range(4):
            try:
                return (it, translate(it['prompt']), None)
            except Exception as e:
                last = str(e)[:80]
                time.sleep(2 + attempt * 3)
        return (it, None, last)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for it, en, err in ex.map(work, todo):
            lock['n'] += 1
            if en:
                it['prompt_en'] = en
                if lock['n'] % 25 == 0:
                    json.dump(data, open(PF, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
                    print('  %d/%d ...' % (lock['n'], len(todo)))
            else:
                print('  ❌ %s — %s' % (it['topic'], err))
    json.dump(data, open(PF, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('完成，已写入 %s' % PF)

if __name__ == '__main__':
    main()
