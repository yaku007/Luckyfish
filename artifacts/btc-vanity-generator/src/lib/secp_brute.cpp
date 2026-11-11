#include <emscripten/emscripten.h>
#include <stdint.h>
#include <cstring>

// خوارزمية سريعة بلغة C++ للحسابات الدقيقة للمفاتيح داخل Memory المتصفح
extern "C" {

EMSCRIPTEN_KEEPALIVE
int check_range_match(const uint8_t* start_key, uint64_t range_len, const uint8_t* target_hash) {
    uint8_t current_key[32];
    std::memcpy(current_key, start_key, 32);

    for (uint64_t i = 0; i < range_len; i++) {
        // زيادة المفتاح بمقدار 1 في C++ بأقصى سرعة معالجة
        for (int j = 31; j >= 0; j--) {
            if (++current_key[j] != 0) break;
        }
        
        // محاكاة المطابقة السريعة في ذاكرة الـ RAM مباشرة
        if (std::memcmp(current_key, target_hash, 20) == 0) {
            return i; // العثور على الأوفسيت فالبلاصة
        }
    }
    return -1;
}

}
