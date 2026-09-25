; CPU self-test ROM: writes results to $7E1000..; checked by tools/test_cpu.js
R = $1000
    .org $8000
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
    sep #$30
    .a8
    .i8
    lda #$00
    pha
    plb
; 1: simple
    lda #$12
    sta R+0
; 2: BCD add
    sed
    clc
    lda #$19
    adc #$28
    sta R+1
; 3: BCD sub
    sec
    lda #$50
    sbc #$01
    sta R+2
    cld
; 4: 16-bit load/store
    rep #$20
    .a16
    lda #$1234
    sta R+3
; 5: 16-bit overflow
    lda #$7FFF
    clc
    adc #$0001
    sta R+5
    php
    sep #$20
    .a8
    pla
    and #$C3
    sta R+7
; 6: XBA
    rep #$20
    .a16
    lda #$ABCD
    sep #$20
    .a8
    xba
    sta R+8
; 7: MVN copy 4 bytes from table to $7E2000
    rep #$30
    .a16
    .i16
    lda #$0003
    ldx #table
    ldy #$2000
    mvn $7E,$00
    phk
    plb
    sep #$30
    .a8
    .i8
    lda $7E2000
    sta R+9
    lda $7E2003
    sta R+10
; 8: JSR/RTS and JSL/RTL
    jsr sub1
    sta R+11
    jsl sub2
    sta R+12
; 9: stack relative
    lda #$55
    pha
    lda #$66
    pha
    lda $02,s
    sta R+13
    pla
    pla
; 10: (dp),Y
    lda #<table
    sta $10
    lda #>table
    sta $11
    ldy #$02
    lda ($10),y
    sta R+14
; 11: hardware multiply/divide
    lda #$0C
    sta $4202
    lda #$0B
    sta $4203
    nop
    nop
    nop
    nop
    lda $4216
    sta R+15
    rep #$20
    .a16
    lda #1000
    sta $4204
    sep #$20
    .a8
    lda #7
    sta $4206
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    nop
    lda $4214
    sta R+16
    lda $4216
    sta R+17
; 12: DMA table -> WRAM $7E3000 via $2180
    lda #$00
    sta $2181
    lda #$30
    sta $2182
    lda #$00
    sta $2183
    lda #$00
    sta $4300
    lda #$80
    sta $4301
    lda #<table
    sta $4302
    lda #>table
    sta $4303
    lda #$00
    sta $4304
    lda #$04
    sta $4305
    lda #$00
    sta $4306
    lda #$01
    sta $420B
    lda $7E3001
    sta R+18
    lda $7E3003
    sta R+19
; 13: 16-bit BCD
    sed
    rep #$20
    .a16
    clc
    lda #$1999
    adc #$0001
    sta R+20
    sec
    lda #$1000
    sbc #$0001
    sta R+22
    sep #$20
    .a8
    cld
; 14: binary SBC borrow
    sec
    lda #$10
    sbc #$20
    sta R+24
    lda #$00
    rol a
    sta R+25
; 15: ROR with carry
    sec
    lda #$02
    ror a
    sta R+26
; 16: CMP flags: 5 vs 5 -> Z,C
    lda #$05
    cmp #$05
    php
    pla
    and #$83
    sta R+27
; 17: TSB/TRB
    lda #$F0
    sta $20
    lda #$0F
    tsb $20
    lda $20
    sta R+28
    lda #$30
    trb $20
    lda $20
    sta R+29
; 18: BRL and 16-bit index loop sum
    brl skip
    lda #$EE
    sta R+30
skip:
    lda #$77
    sta R+31
    rep #$10
    .i16
    ldx #$0000
    lda #$00
loop1:
    clc
    adc #$01
    inx
    cpx #$0100
    bne loop1
    sep #$10
    .i8
    sta R+32
; 19: PEA / PLA
    rep #$20
    .a16
    pea $BEEF
    pla
    sta R+33
    sep #$20
    .a8
; 20: (dp,X) and [dp],Y
    ldx #$04
    lda #<table
    sta $14
    lda #>table
    sta $15
    lda ($10,x)
    sta R+35
    lda #$00
    sta $12
    ldy #$03
    lda [$10],y
    sta R+36
; 21: ASL 16-bit sets carry
    rep #$20
    .a16
    lda #$8001
    asl a
    sta R+37
    sep #$20
    .a8
    lda #$00
    rol a
    sta R+39
; 22: native-mode NMI through vblank
    stz nmicount
    lda #$81
    sta $4200
    cli
wait:
    lda nmicount
    beq wait
    sta R+40
    lda #$A5
    sta R+63
done:
    bra done

nmicount = $30

sub1:
    lda #$42
    rts
sub2:
    lda #$43
    rtl

nmi:
    pha
    lda $4210
    inc nmicount
    pla
    rti

irq:
    rti

table:
    .db $11, $22, $33, $44

    .org $FFC0
    .db "CPU TEST             "
    .db $20, $00, $08, $00, $01, $33, $00
    .dw $0000, $FFFF
    .org $FFE4
    .dw irq, irq, irq, nmi, irq, irq
    .org $FFF4
    .dw irq, irq, irq, irq, reset, irq
