package android.content;

import java.util.HashMap;
import java.util.Map;

/** 测试用最小 SharedPreferences 桩：内存里存键值，够 Providers / 设置用。 */
public class SharedPreferences {

    public static final int MODE_PRIVATE = 0;

    private final Map<String, String> map = new HashMap<>();

    public String getString(String key, String def) {
        String v = map.get(key);
        return v == null ? def : v;
    }

    public int getInt(String key, int def) {
        String v = map.get(key);
        try { return v == null ? def : Integer.parseInt(v); } catch (Exception e) { return def; }
    }

    public boolean getBoolean(String key, boolean def) {
        String v = map.get(key);
        return v == null ? def : "true".equals(v);
    }

    public Editor edit() {
        return new Editor();
    }

    public class Editor {
        private final Map<String, String> pending = new HashMap<>();

        public Editor putString(String key, String value) {
            pending.put(key, value);
            return this;
        }

        public Editor putInt(String key, int value) {
            pending.put(key, String.valueOf(value));
            return this;
        }

        public Editor putBoolean(String key, boolean value) {
            pending.put(key, String.valueOf(value));
            return this;
        }

        public Editor remove(String key) {
            pending.put(key, null);
            return this;
        }

        public Editor clear() {
            map.clear();
            return this;
        }

        public void apply() {
            for (Map.Entry<String, String> e : pending.entrySet()) {
                if (e.getValue() == null) map.remove(e.getKey());
                else map.put(e.getKey(), e.getValue());
            }
            pending.clear();
        }

        public boolean commit() {
            apply();
            return true;
        }
    }
}
