package top.lngzunoma.alphatraderai;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OwnerTokenPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
