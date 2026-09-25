; "Paddle Duel" - built-in two-player demo for the emulator
; Controls: Player 1 and Player 2 press Up/Down to move. Start re-serves.
    .org $8000

frame   = $00
p1y     = $02
p2y     = $03
bx      = $04
by      = $05
dx      = $06
dy      = $07
score1  = $08
score2  = $09
sndcnt  = $0A
serve   = $0B
nmiflag = $10
tmp     = $12
OAMBUF  = $0200

reset:
    sei
    clc
    xce
    rep #$30
    .a16
    .i16
    ldx #$1FFF
    txs
    lda #$0000
    tcd
    sep #$20
    .a8
    lda #$00
    pha
    plb
    lda #$8F
    sta $2100          ; forced blank
    stz $4200
    ; clear PPU regs we care about
    stz $2105
    stz $2106
    lda #$01
    sta $2105          ; mode 1
    lda #$00
    sta $2107          ; BG1 tilemap at word $0000
    lda #$01
    sta $210B          ; BG1 chars at word $1000
    lda #$01
    sta $2101          ; OBJ 8x8/16x16, chars at word $2000
    lda #$FF
    sta $210E
    sta $210E          ; BG1 VOFS = -1
    stz $210D
    stz $210D
    lda #$11
    sta $212C          ; main screen: BG1 + OBJ
    stz $212D
    stz $2130
    stz $2131
    stz $2133

    ; ---- palette ----
    stz $2121
    ldx #$0000
pal_loop:
    lda palette,x
    sta $2122
    inx
    cpx #PAL_LEN
    bne pal_loop
    ; sprite palettes at CGRAM 128
    lda #$80
    sta $2121
    ldx #$0000
spal_loop:
    lda spalette,x
    sta $2122
    inx
    cpx #SPAL_LEN
    bne spal_loop

    ; ---- VRAM uploads via DMA channel 0 ----
    lda #$80
    sta $2115
    ; BG tiles -> $1000
    ldx #$1000
    stx $2116
    ldx #bgtiles
    ldy #BGT_LEN
    jsr vram_dma
    ; OBJ tiles -> $2000
    ldx #$2000
    stx $2116
    ldx #objtiles
    ldy #OBJT_LEN
    jsr vram_dma
    ; tilemap -> $0000
    ldx #$0000
    stx $2116
    ldx #tilemap
    ldy #$0800
    jsr vram_dma

    ; ---- clear OAM buffer ----
    ldx #$0000
oam_clr:
    lda #$00
    sta OAMBUF,x
    lda #$F0
    sta OAMBUF+1,x
    lda #$00
    sta OAMBUF+2,x
    sta OAMBUF+3,x
    inx
    inx
    inx
    inx
    cpx #$0200
    bne oam_clr
oam_clr2:
    stz OAMBUF,x
    inx
    cpx #$0220
    bne oam_clr2

    ; ---- sound driver upload ----
    jsr spc_upload

    ; ---- game state ----
    lda #88
    sta p1y
    sta p2y
    stz score1
    stz score2
    stz sndcnt
    jsr serve_ball

    sep #$10
    .i8
    lda #$0F
    sta $2100          ; screen on, full brightness
    lda #$81
    sta $4200          ; NMI + auto joypad
    cli

main:
    wai
    lda nmiflag
    beq main
    stz nmiflag
    jsr update
    jsr build_oam
    bra main

; ---------------------------------------------------------------
update:
    inc frame
    ; wait until auto-joypad read is finished
wait_joy:
    lda $4212
    and #$01
    bne wait_joy
    ; player 1
    lda $4219
    sta tmp
    lda p1y
    jsr move_paddle
    sta p1y
    ; player 2
    lda $421B
    sta tmp
    lda p2y
    jsr move_paddle
    sta p2y
    ; start re-serves
    lda $4219
    ora $421B
    and #$10
    beq no_start
    lda serve
    bne no_start
    jsr serve_ball
no_start:
    lda serve
    beq ball_move
    dec serve
    rts
ball_move:
    lda bx
    clc
    adc dx
    sta bx
    lda by
    clc
    adc dy
    sta by
    ; walls
    lda by
    cmp #16
    bcs no_top
    lda #16
    sta by
    jsr flip_dy
    lda #$06
    jsr beep
no_top:
    lda by
    cmp #201
    bcc no_bottom
    lda #200
    sta by
    jsr flip_dy
    lda #$06
    jsr beep
no_bottom:
    ; left paddle
    lda dx
    bpl check_right
    lda bx
    cmp #25
    bcs check_scores
    cmp #14
    bcc check_scores
    lda p1y
    jsr hit_test
    bcc check_scores
    lda #24
    sta bx
    lda #$02
    sta dx
    lda p1y
    jsr english
    lda #$08
    jsr beep
    bra check_scores
check_right:
    lda bx
    cmp #224
    bcc check_scores
    cmp #235
    bcs check_scores
    lda p2y
    jsr hit_test
    bcc check_scores
    lda #224
    sta bx
    lda #$FE
    sta dx
    lda p2y
    jsr english
    lda #$08
    jsr beep
check_scores:
    lda bx
    cmp #4
    bcs no_left_out
    inc score2
    lda score2
    cmp #10
    bcc s2ok
    stz score2
s2ok:
    jsr serve_ball
    lda #$03
    jsr beep
    rts
no_left_out:
    cmp #245
    bcc done_update
    inc score1
    lda score1
    cmp #10
    bcc s1ok
    stz score1
s1ok:
    jsr serve_ball
    lda #$03
    jsr beep
done_update:
    rts

; A = paddle y, tmp = joypad high byte. Returns new y in A.
move_paddle:
    sta tmp+1
    lda tmp
    and #$08          ; up
    beq mp_down
    lda tmp+1
    sec
    sbc #3
    cmp #16
    bcs mp_up_ok
    lda #16
mp_up_ok:
    sta tmp+1
mp_down:
    lda tmp
    and #$04          ; down
    beq mp_done
    lda tmp+1
    clc
    adc #3
    cmp #177
    bcc mp_dn_ok
    lda #176
mp_dn_ok:
    sta tmp+1
mp_done:
    lda tmp+1
    rts

; carry set if ball overlaps paddle at y = A (paddle is 32 tall, ball 8)
hit_test:
    sta tmp+1
    lda by
    clc
    adc #8
    cmp tmp+1
    bcc ht_no            ; by+8 < py  -> miss
    beq ht_no
    lda tmp+1
    clc
    adc #32
    cmp by
    bcc ht_no            ; py+32 < by -> miss
    beq ht_no
    sec
    rts
ht_no:
    clc
    rts

; set dy from where the ball hit the paddle (A = paddle y)
english:
    sta tmp+1
    lda by
    clc
    adc #4
    sec
    sbc tmp+1          ; offset 0..39
    cmp #10
    bcs en_mid
    lda #$FE
    sta dy
    rts
en_mid:
    cmp #30
    bcc en_center
    lda #$02
    sta dy
    rts
en_center:
    lda dy
    bmi en_up1
    lda #$01
    sta dy
    rts
en_up1:
    lda #$FF
    sta dy
    rts

flip_dy:
    lda dy
    eor #$FF
    inc a
    sta dy
    rts

serve_ball:
    lda #124
    sta bx
    lda #108
    sta by
    lda #60
    sta serve
    lda frame
    and #$01
    beq sv_left
    lda #$02
    sta dx
    bra sv_dy
sv_left:
    lda #$FE
    sta dx
sv_dy:
    lda frame
    and #$02
    beq sv_up
    lda #$01
    sta dy
    rts
sv_up:
    lda #$FF
    sta dy
    rts

; A = pitch (high byte) -> tell the sound driver to play a blip
beep:
    sta $2141
    inc sndcnt
    lda sndcnt
    sta $2140
    rts

build_oam:
    ; paddle 1 (sprites 0-3)
    lda p1y
    sta tmp
    ldx #$00
bo_p1:
    lda #16
    sta OAMBUF,x
    lda tmp
    sta OAMBUF+1,x
    clc
    adc #8
    sta tmp
    lda #$00
    sta OAMBUF+2,x
    lda #$30
    sta OAMBUF+3,x
    inx
    inx
    inx
    inx
    cpx #16
    bne bo_p1
    ; paddle 2 (sprites 4-7)
    lda p2y
    sta tmp
bo_p2:
    lda #232
    sta OAMBUF,x
    lda tmp
    sta OAMBUF+1,x
    clc
    adc #8
    sta tmp
    lda #$00
    sta OAMBUF+2,x
    lda #$32
    sta OAMBUF+3,x
    inx
    inx
    inx
    inx
    cpx #32
    bne bo_p2
    ; ball (sprite 8), blinks while waiting to serve
    lda bx
    sta OAMBUF+32
    lda serve
    and #$08
    beq bo_show
    lda #$F0
    bra bo_sety
bo_show:
    lda by
bo_sety:
    sta OAMBUF+33
    lda #$01
    sta OAMBUF+34
    lda #$34
    sta OAMBUF+35
    rts

; X = source address (bank 0), Y = byte count; VRAM address already set
    .i16
vram_dma:
    lda #$01
    sta $4300          ; mode 1: two registers ($2118/$2119)
    lda #$18
    sta $4301
    stx $4302
    lda #$00
    sta $4304
    sty $4305
    lda #$01
    sta $420B
    rts

; Upload the sound driver using the IPL boot protocol
spc_upload:
spc_wait:
    lda $2140
    cmp #$AA
    bne spc_wait
    lda $2141
    cmp #$BB
    bne spc_wait
    lda #$00
    sta $2142
    lda #$02
    sta $2143
    lda #$01
    sta $2141
    lda #$CC
    sta $2140
spc_w1:
    cmp $2140
    bne spc_w1
    ldx #$0000
spc_next:
    lda spcblob,x
    sta $2141
    txa
    sta $2140
spc_w2:
    cmp $2140
    bne spc_w2
    inx
    cpx #SPC_LEN
    bne spc_next
    stz $2141
    lda #$00
    sta $2142
    lda #$02
    sta $2143
    txa
    clc
    adc #$02
    sta $2140
spc_w3:
    cmp $2140
    bne spc_w3
    ; driver takes over; clear port 0 expectation
    rts
    .i8

nmi:
    rep #$30
    .a16
    .i16
    pha
    phx
    phy
    phb
    phd
    lda #$0000
    tcd
    sep #$20
    .a8
    lda #$00
    pha
    plb
    lda $4210
    ; OAM DMA
    stz $2102
    stz $2103
    lda #$00
    sta $4300
    lda #$04
    sta $4301
    ldx #OAMBUF
    stx $4302
    lda #$00
    sta $4304
    ldx #$0220
    stx $4305
    lda #$01
    sta $420B
    ; scores: big digits are two tiles tall (rows 2 and 3)
    lda #$80
    sta $2115
    ldx #$004C
    stx $2116
    lda score1
    asl a
    clc
    adc #3
    sta $2118
    stz $2119
    ldx #$006C
    stx $2116
    inc a
    sta $2118
    stz $2119
    ldx #$0053
    stx $2116
    lda score2
    asl a
    clc
    adc #3
    sta $2118
    stz $2119
    ldx #$0073
    stx $2116
    inc a
    sta $2118
    stz $2119
    lda #$01
    sta nmiflag
    rep #$30
    .a16
    .i16
    pld
    plb
    ply
    plx
    pla
    sep #$30
    .a8
    .i8
    rti

irq:
    rti

palette:
    .bytes palette
spalette:
    .bytes spalette
bgtiles:
    .bytes bgtiles
objtiles:
    .bytes objtiles
tilemap:
    .bytes tilemap
spcblob:
    .bytes spcblob

    .org $FFC0
    .db "PADDLE DUEL DEMO     "
    .db $20, $00, $08, $00, $01, $33, $00
    .dw $0000, $FFFF
    .org $FFE4
    .dw irq, irq, irq, nmi, irq, irq
    .org $FFF4
    .dw irq, irq, irq, irq, reset, irq
