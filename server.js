const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = {};

// チンチロの役判定ロジック（正しい序列）
// 1. ピンゾロ (1-1-1)
// 2. シゴロ (4-5-6)
// 3. アラシ (2~6のゾロ目、数字が大きい方が強い)
// 4. nの目 (通常の目、数字が大きい方が強い)
// 5. 目なし (やり直し。3回で目なし固定)
// 6. ヒフミ (1-2-3)
function judgeChinchiro(dice) {
    const sorted = [...dice].sort((a, b) => a - b);
    
    // ピンゾロ (5倍)
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 6, name: 'ピンゾロ (5倍)', multiplier: 5, score: 100 };
    }
    // シゴロ (2倍)
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 5, name: 'シゴロ (2倍)', multiplier: 2, score: 40 };
    }
    // アラシ (ゾロ目 2~6) -> 3倍、数字が大きい方が強い
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `${sorted[0]}のゾロ目 (3倍)`, multiplier: 3, score: 50 + sorted[0] };
    }
    
    const unique = [...new Set(sorted)];
    // nの目 (通常の目) -> 1倍、出目の大きい方が強い
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 3, name: `${eye}の目 (1倍)`, multiplier: 1, score: eye };
    }
    
    // ヒフミ (2倍負け)
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: 1, name: 'ヒフミ (2倍負け)', multiplier: 2, score: -10 };
    }
    
    // 目なし (やり直し)
    return { rank: 2, name: '目なし', multiplier: 0, score: 0 };
}

io.on('connection', (socket) => {
    console.log(`新しい賭博者が接続: ${socket.id}`);

    socket.on('create-room', ({ userName, wallet }) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        rooms[roomId] = {
            host: socket.id,
            gameMaster: socket.id,
            currentTurnIndex: 0,
            turnsPlayed: 0,
            players: [{
                id: socket.id,
                name: userName,
                chips: wallet !== undefined ? wallet : 1000,
                role: 'host',
                failCount: 0,
                bet: 100,
                lastDice: null,
                lastResult: null
            }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players, gameMaster: rooms[roomId].gameMaster });
    });

    socket.on('join-room', ({ roomId, userName, wallet }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error-msg', '指定された部屋は見つかりません');
            return;
        }
        if (room.status === 'playing') {
            socket.emit('error-msg', 'すでにゲームが開始されているため参加できません');
            return;
        }
        if (room.players.length >= 10) {
            socket.emit('error-msg', '部屋が満員です（最大10人）');
            return;
        }

        room.players.push({
            id: socket.id,
            name: userName,
            chips: wallet !== undefined ? wallet : 1000,
            role: 'guest',
            failCount: 0,
            bet: 100,
            lastDice: null,
            lastResult: null
        });

        socket.join(roomId);
        io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
        socket.emit('joined', { roomId, players: room.players, gameMaster: room.gameMaster });
    });

    socket.on('set-game-master', ({ roomId, targetSocketId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;
        
        const target = room.players.find(p => p.id === targetSocketId);
        if (target) {
            room.gameMaster = targetSocketId;
            io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
        }
    });

    socket.on('start-game', ({ roomId, defaultBet }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;

        if (room.players.length < 2) {
            socket.emit('error-msg', 'ゲームを開始するには2人以上のプレイヤーが必要です！');
            return;
        }

        const betAmount = parseInt(defaultBet) || 100;

        room.status = 'playing';
        const gmIndex = room.players.findIndex(p => p.id === room.gameMaster);
        room.currentTurnIndex = gmIndex !== -1 ? gmIndex : 0;
        room.turnsPlayed = 0;
        
        room.players.forEach(p => {
            p.failCount = 0;
            p.bet = betAmount;
            p.lastDice = null;
            p.lastResult = null;
            // ラウンド開始時に全員から掛け金を徴収（マイナス＝借金も許容）
            p.chips -= betAmount;
        });

        io.to(roomId).emit('game-started', {
            currentTurnId: room.players[room.currentTurnIndex].id,
            gameMasterId: room.gameMaster,
            players: room.players
        });
    });

    socket.on('roll-dice', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('error-msg', 'あなたのターンではありません！');
            return;
        }

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        // 目なしの場合の処理
        if (result.rank === 2) {
            currentPlayer.failCount = (currentPlayer.failCount || 0) + 1;
            
            // 3回目で目なし固定
            if (currentPlayer.failCount >= 3) {
                currentPlayer.lastDice = dice;
                currentPlayer.lastResult = result;
                advanceTurn(room, socket, dice, result, false);
                return;
            }

            // 通常の目なし（やり直し） -> 同じプレイヤーのままもう一度振らせる
            io.to(roomId).emit('dice-result', {
                playerName: currentPlayer.name,
                dice,
                result,
                isRetry: true,
                nextTurnId: currentPlayer.id,
                nextTurnName: currentPlayer.name,
                players: room.players
            });
            return;
        }

        // 目が出たので確定
        currentPlayer.failCount = 0;
        currentPlayer.lastDice = dice;
        currentPlayer.lastResult = result;

        advanceTurn(room, socket, dice, result, false);
    });

    function advanceTurn(room, socket, dice, result, isRetry) {
        const currentPlayer = room.players[room.currentTurnIndex];
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        room.turnsPlayed++;

        const isFinished = room.turnsPlayed >= room.players.length;

        if (isFinished) {
            room.status = 'waiting';
            processGameResults(room);
        }

        const nextPlayer = isFinished ? null : room.players[room.currentTurnIndex];

        io.to(roomId).emit('dice-result', {
            playerName: currentPlayer.name,
            dice,
            result,
            isRetry,
            isFinished,
            nextTurnId: nextPlayer ? nextPlayer.id : null,
            nextTurnName: nextPlayer ? nextPlayer.name : null,
            players: room.players,
            roundSummary: isFinished ? room.roundSummary : null
        });
    }

    // 全員終了時の総取り・精算ロジック
    function processGameResults(room) {
        const evaluated = room.players.map(p => {
            const r = p.lastResult || { rank: 2, name: '目なし', multiplier: 0, score: 0 };
            return {
                player: p,
                rank: r.rank,
                score: r.score,
                multiplier: r.multiplier,
                isHifumi: r.rank === 1
            };
        });

        // 最強のランクとスコアを見つける
        let maxRank = -999;
        let maxScore = -999;
        evaluated.forEach(e => {
            if (e.rank > maxRank) {
                maxRank = e.rank;
                maxScore = e.score;
            } else if (e.rank === maxRank && e.score > maxScore) {
                maxScore = e.score;
            }
        });

        let topCandidates = evaluated.filter(e => e.rank === maxRank && e.score === maxScore);
        let winners = [];
        const gmId = room.gameMaster;

        // ローカルルール：「被った場合は親が負け、子同士の被りは分け」
        if (topCandidates.length > 1) {
            const hasGm = topCandidates.some(e => e.player.id === gmId);
            if (hasGm) {
                winners = topCandidates.filter(e => e.player.id !== gmId);
                if (winners.length === 0) {
                    winners = topCandidates.filter(e => e.player.id === gmId);
                }
            } else {
                winners = topCandidates;
            }
        } else {
            winners = topCandidates;
        }

        // ヒフミを出したプレイヤーは自分の掛け金2倍の罰金を追加徴収
        evaluated.forEach(e => {
            if (e.isHifumi) {
                const penalty = e.player.bet * 2;
                e.player.chips -= penalty;
            }
        });

        // ポット（全員の掛け金の総額）を計算
        let totalPot = room.players.reduce((sum, p) => sum + p.bet, 0);

        // シゴロやピンゾロなどの倍率に応じた追加ボーナス回収（敗者から徴収してポットに上乗せ、あるいは勝者へ直接配分）
        // ここではシンプルに、勝者の倍率に応じて敗者から追加で巻き上げる
        const winnerMult = winners[0] ? winners[0].multiplier : 1;
        
        let additionalCollected = 0;
        evaluated.forEach(e => {
            const isWinner = winners.some(w => w.player.id === e.player.id);
            if (!isWinner && winnerMult > 1) {
                const extra = e.player.bet * (winnerMult - 1);
                e.player.chips -= extra;
                additionalCollected += extra;
            }
        });

        const finalPot = totalPot + additionalCollected;
        const share = Math.floor(finalPot / winners.length);

        winners.forEach(w => {
            w.player.chips += share;
        });

        room.roundSummary = {
            winnerNames: winners.map(w => `${w.player.name} (${w.player.lastResult.name})`).join(', '),
            totalPot: finalPot
        };
    }

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const wasHost = room.host === socket.id;
            const wasGm = room.gameMaster === socket.id;
            room.players = room.players.filter(p => p.id !== socket.id);
            
            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                if (wasHost && room.players.length > 0) {
                    room.host = room.players[0].id;
                    room.players[0].role = 'host';
                    io.to(roomId).emit('host-changed', { newHostId: room.host });
                }
                if (wasGm && room.players.length > 0) {
                    room.gameMaster = room.players[0].id;
                }
                if (room.currentTurnIndex >= room.players.length) {
                    room.currentTurnIndex = 0;
                }
                io.to(roomId).emit('update-room', { players: room.players, gameMaster: room.gameMaster });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`闇のチンチロ胴元サーバーがポート ${PORT} で起動しました`);
});
