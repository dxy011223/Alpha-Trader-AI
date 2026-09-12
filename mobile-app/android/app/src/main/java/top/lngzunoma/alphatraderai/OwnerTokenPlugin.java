package top.lngzunoma.alphatraderai;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "OwnerToken")
public class OwnerTokenPlugin extends Plugin {
    private static final String TAG = "OwnerTokenPlugin";
    private static final String KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "alpha_trader_owner_token_v1";
    private static final String PREFERENCES = "alpha_trader_secure_values";
    private static final String TOKEN_ENTRY = "owner_token_ciphertext";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String VALUE_PREFIX = "v1:";

    @PluginMethod
    public void getToken(PluginCall call) {
        JSObject result = new JSObject();
        String encrypted = preferences().getString(TOKEN_ENTRY, null);
        if (encrypted == null || encrypted.isEmpty()) {
            result.put("token", "");
            call.resolve(result);
            return;
        }

        try {
            result.put("token", decrypt(encrypted));
            call.resolve(result);
        } catch (Exception exception) {
            // 密钥失效或密文损坏时清除数据，避免应用永久卡在读取失败状态。
            preferences().edit().remove(TOKEN_ENTRY).apply();
            Log.e(TAG, "读取安全令牌失败，已清除损坏数据", exception);
            result.put("token", "");
            call.resolve(result);
        }
    }

    @PluginMethod
    public void setToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.trim().isEmpty()) {
            call.reject("安全令牌不能为空");
            return;
        }

        try {
            preferences().edit().putString(TOKEN_ENTRY, encrypt(token.trim())).apply();
            call.resolve();
        } catch (Exception exception) {
            Log.e(TAG, "保存安全令牌失败", exception);
            call.reject("安全令牌保存失败", exception);
        }
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        preferences().edit().remove(TOKEN_ENTRY).apply();
        call.resolve();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEY_STORE);
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        cipher.updateAAD(KEY_ALIAS.getBytes(StandardCharsets.UTF_8));
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String ciphertext = Base64.encodeToString(
            cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),
            Base64.NO_WRAP
        );
        return VALUE_PREFIX + iv + ":" + ciphertext;
    }

    private String decrypt(String storedValue) throws Exception {
        if (!storedValue.startsWith(VALUE_PREFIX)) throw new IllegalArgumentException("不支持的安全令牌格式");
        String[] parts = storedValue.substring(VALUE_PREFIX.length()).split(":", 2);
        if (parts.length != 2) throw new IllegalArgumentException("安全令牌数据不完整");

        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(KEY_ALIAS.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }
}
