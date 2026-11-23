/**
 * 协议 v2 —— 18 字节定长帧（固件侧实现）
 *
 * 必须与 `src/gateway/frame.ts` **逐字节一致**。两边的契约靠开机自检 + PC 端脚本互验，
 * 不靠"我记得是这样"。
 *
 * 布局（小端）：
 *   0   1  magic 0xA7   1  1  ver 0x02   2  1  type
 *   3   2  seq          5  4  payload   9  2  x   11  2  y   13  2  z
 *   15  1  steps        16 2  crc16(CCITT-FALSE, 覆盖 0..15)
 */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>

#define FFRAME_MAGIC 0xA7
#define FFRAME_VER   2
#define FFRAME_SIZE  18

#define FFRAME_TYPE_DATA  0x01
#define FFRAME_TYPE_ACK   0x02
#define FFRAME_TYPE_CMD   0x03
#define FFRAME_TYPE_HELLO 0x04

static const int FFRAME_MAX_MILLI_G = 16000;   // ±16g
static const int FFRAME_MAX_STEPS   = 50;      // 5 秒窗口上限

static inline uint16_t fframe_crc16(const uint8_t *b, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)b[i] << 8;
        for (int k = 0; k < 8; k++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

static inline void fframe_put_u16(uint8_t *b, int off, uint16_t v) {
    b[off] = (uint8_t)(v & 0xFF);
    b[off + 1] = (uint8_t)((v >> 8) & 0xFF);
}

static inline void fframe_put_u32(uint8_t *b, int off, uint32_t v) {
    b[off] = (uint8_t)(v & 0xFF);
    b[off + 1] = (uint8_t)((v >> 8) & 0xFF);
    b[off + 2] = (uint8_t)((v >> 16) & 0xFF);
    b[off + 3] = (uint8_t)((v >> 24) & 0xFF);
}

static inline uint16_t fframe_get_u16(const uint8_t *b, int off) {
    return (uint16_t)(b[off] | ((uint16_t)b[off + 1] << 8));
}

static inline uint32_t fframe_get_u32(const uint8_t *b, int off) {
    return (uint32_t)b[off] | ((uint32_t)b[off + 1] << 8) |
           ((uint32_t)b[off + 2] << 16) | ((uint32_t)b[off + 3] << 24);
}

static inline int16_t fframe_get_i16(const uint8_t *b, int off) {
    return (int16_t)fframe_get_u16(b, off);
}

static inline int16_t fframe_clamp_mg(float g) {
    long v = lroundf(g * 1000.0f);
    if (v > FFRAME_MAX_MILLI_G) v = FFRAME_MAX_MILLI_G;
    if (v < -FFRAME_MAX_MILLI_G) v = -FFRAME_MAX_MILLI_G;
    return (int16_t)v;
}

static inline void fframe_head(uint8_t *b, uint8_t type) {
    memset(b, 0, FFRAME_SIZE);
    b[0] = FFRAME_MAGIC;
    b[1] = FFRAME_VER;
    b[2] = type;
}

static inline void fframe_finish(uint8_t *b) {
    fframe_put_u16(b, FFRAME_SIZE - 2, fframe_crc16(b, FFRAME_SIZE - 2));
}

static inline size_t fframe_encode_data(uint8_t *out, uint16_t seq, uint32_t deviceTs,
                                        float x, float y, float z, uint8_t steps) {
    fframe_head(out, FFRAME_TYPE_DATA);
    fframe_put_u16(out, 3, seq);
    fframe_put_u32(out, 5, deviceTs);
    fframe_put_u16(out, 9,  (uint16_t)fframe_clamp_mg(x));
    fframe_put_u16(out, 11, (uint16_t)fframe_clamp_mg(y));
    fframe_put_u16(out, 13, (uint16_t)fframe_clamp_mg(z));
    out[15] = steps > FFRAME_MAX_STEPS ? (uint8_t)FFRAME_MAX_STEPS : steps;
    fframe_finish(out);
    return FFRAME_SIZE;
}

static inline size_t fframe_encode_ack(uint8_t *out, uint16_t seq) {
    fframe_head(out, FFRAME_TYPE_ACK);
    fframe_put_u16(out, 3, seq);
    fframe_finish(out);
    return FFRAME_SIZE;
}

static inline size_t fframe_encode_hello(uint8_t *out, uint8_t proto, uint8_t major, uint8_t minor) {
    fframe_head(out, FFRAME_TYPE_HELLO);
    fframe_put_u32(out, 5, ((uint32_t)proto << 16) | ((uint32_t)major << 8) | (uint32_t)minor);
    fframe_finish(out);
    return FFRAME_SIZE;
}

/** 长度、magic、ver、CRC 全过才算合法帧 */
static inline bool fframe_valid(const uint8_t *b, size_t len) {
    if (len != FFRAME_SIZE) return false;
    if (b[0] != FFRAME_MAGIC) return false;
    if (b[1] != FFRAME_VER) return false;
    return fframe_crc16(b, FFRAME_SIZE - 2) == fframe_get_u16(b, FFRAME_SIZE - 2);
}

/** 开机自检：CRC 标准向量 + 与 TS 实现交叉验证的 3 组字节 */
static inline bool fframe_selftest() {
    bool ok = true;

    const uint8_t check[9] = {'1','2','3','4','5','6','7','8','9'};
    if (fframe_crc16(check, 9) != 0x29B1) {
        Serial.println("[FRAME] FAIL: crc16(\"123456789\") != 0x29B1");
        ok = false;
    }

    struct Vec {
        uint16_t seq; uint32_t ts; float x, y, z; uint8_t steps;
        uint8_t want[FFRAME_SIZE];
    };
    static const Vec vecs[] = {
        {1,     1795350879, 0.02f, -0.02f, -1.09f,  3,
         {0xa7,0x02,0x01,0x01,0x00,0x5f,0xe1,0x02,0x6b,0x14,0x00,0xec,0xff,0xbe,0xfb,0x03,0x79,0xef}},
        {65535, 0,          -1.5f,  2.25f,  0.001f, 0,
         {0xa7,0x02,0x01,0xff,0xff,0x00,0x00,0x00,0x00,0x24,0xfa,0xca,0x08,0x01,0x00,0x00,0x2f,0x2d}},
        {300,   1795000000, 0.0f,   0.0f,   1.0f,   50,
         {0xa7,0x02,0x01,0x2c,0x01,0xc0,0x86,0xfd,0x6a,0x00,0x00,0x00,0x00,0xe8,0x03,0x32,0x1a,0x1c}},
    };

    for (size_t i = 0; i < sizeof(vecs) / sizeof(vecs[0]); i++) {
        uint8_t out[FFRAME_SIZE];
        fframe_encode_data(out, vecs[i].seq, vecs[i].ts, vecs[i].x, vecs[i].y, vecs[i].z, vecs[i].steps);
        if (memcmp(out, vecs[i].want, FFRAME_SIZE) != 0) {
            Serial.printf("[FRAME] FAIL: 向量 %u 与 TS 实现不一致\n", (unsigned)i);
            ok = false;
        }
    }

    const uint8_t ackWant[FFRAME_SIZE] = {0xa7,0x02,0x02,0xd2,0x04,0,0,0,0,0,0,0,0,0,0,0,0x3d,0x89};
    uint8_t ack[FFRAME_SIZE];
    fframe_encode_ack(ack, 1234);
    if (memcmp(ack, ackWant, FFRAME_SIZE) != 0) {
        Serial.println("[FRAME] FAIL: ack 向量不一致");
        ok = false;
    }

    const uint8_t helloWant[FFRAME_SIZE] = {0xa7,0x02,0x04,0,0,0x07,0x01,0x02,0,0,0,0,0,0,0,0,0x13,0x7c};
    uint8_t hello[FFRAME_SIZE];
    fframe_encode_hello(hello, 2, 1, 7);
    if (memcmp(hello, helloWant, FFRAME_SIZE) != 0) {
        Serial.println("[FRAME] FAIL: hello 向量不一致");
        ok = false;
    }

    Serial.printf("[FRAME] 自检 %s（18 字节帧 / CRC16-CCITT-FALSE）\n", ok ? "PASS" : "FAIL");
    return ok;
}
