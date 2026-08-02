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

// チンチロの役判定ロジック
function judgeChinchiro(dice) {
    const sorted = [...dice].sort((a, b) => a - b);
    
    if (sorted[0] === 1 && sorted[1] === 1 && sorted[2] === 1) {
        return { rank: 5, name: 'ピンゾロ (5倍)', multiplier: 5, score: 100 };
    }
    if (sorted[0] === sorted[1] && sorted[1] === sorted[2]) {
        return { rank: 4, name: `${sorted[0]}のゾロ目 (3倍)`, multiplier: 3, score: 50 + sorted[0] };
    }
    if (sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6) {
        return { rank: 3, name: 'シゴロ (2倍)', multiplier: 2, score: 40 };
    }
    if (sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3) {
        return { rank: -1, name: 'ヒフミ (2倍負け)', multiplier: 2, score: -10 };
    }
    
    const unique = [...new Set(sorted)];
    if (unique.length === 2) {
        const eye = sorted.find(x => sorted.filter(v => v === x).length === 1);
        return { rank: 1, name: `${eye}の目 (1倍)`, multiplier: 1, score: eye };
    }
    
    return { rank: 0, name: '目なし', multiplier: 0, score: -20 };
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
                bet: 0,
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
            bet: 0,
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

    socket.on('start-game', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.host !== socket.id) return;

        if (room.players.length < 2) {
            socket.emit('error-msg', 'ゲームを開始するには2人以上のプレイヤーが必要です！');
            return;
        }

        room.status = 'playing';
        // 親（gameMaster）からターンを開始する
        const gmIndex = room.players.findIndex(p => p.id === room.gameMaster);
        room.currentTurnIndex = gmIndex !== -1 ? gmIndex : 0;
        room.turnsPlayed = 0;
        
        room.players.forEach(p => {
            p.failCount = 0;
            p.bet = 0;
            p.lastDice = null;
            p.lastResult = null;
        });

        io.to(roomId).emit('game-started', {
            currentTurnId: room.players[room.currentTurnIndex].id,
            gameMasterId: room.gameMaster
        });
    });

    socket.on('roll-dice', ({ roomId, bet }) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentTurnIndex];
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('error-msg', 'あなたのターンではありません！');
            return;
        }

        if (bet <= 0) {
            socket.emit('error-msg', '有効なベット額ではありません');
            return;
        }

        currentPlayer.bet = bet;

        const dice = [
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1,
            Math.floor(Math.random() * 6) + 1
        ];

        const result = judgeChinchiro(dice);

        // 目なしの場合の処理
        if (result.rank === 0) {
            currentPlayer.failCount = (currentPlayer.failCount || 0) + 1;
            
            // 3回目で目なし固定
            if (currentPlayer.failCount >= 3) {
                currentPlayer.lastDice = dice;
                currentPlayer.lastResult = result;
                
                // 次のプレイヤーへ進む
                advanceTurn(room, socket, dice, result, false, false);
                return;
            }

            // 通常の目なし（やり直し）
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

        advanceTurn(room, socket, dice, result, false, false);
    });

    function advanceTurn(room, socket, dice, result, isRetry, isPenalty) {
        const currentPlayer = room.players[room.currentTurnIndex];
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        room.turnsPlayed++;

        const isFinished = room.turnsPlayed >= room.players.length;

        if (isFinished) {
            room.status = 'waiting';
            // 全員振り終わったので精算処理を実行
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
        // 各プレイヤーのランクとスコアを整理
        // ヒフミ (-1) は目なし(0)より下とする
        const evaluated = room.players.map(p => {
            const r = p.lastResult || { rank: -2, name: '未参加', multiplier: 1, score: -100 };
            return {
                player: p,
                rank: r.rank,
                score: r.score,
                multiplier: r.multiplier,
                isHifumi: r.rank === -1
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

        // トップのプレイヤー候補を抽出
        let topCandidates = evaluated.filter(e => e.rank === maxRank && e.score === maxScore);

        // ローカルルール適用：「被った場合は親が負け、子同士の被りは分け」
        let winners = [];
        const gmId = room.gameMaster;

        if (topCandidates.length > 1) {
            // トップが複数いる場合
            // 親が含まれているか確認
            const hasGm = topCandidates.some(e => e.player.id === gmId);
            if (hasGm) {
                // 親が被った場合は親の負け -> 親を除外
                winners = topCandidates.filter(e => e.player.id !== gmId);
                // 除外した結果誰もいなくなったら（全員親で被った等の異常系）、残った中で再選定か子全員の勝ちとするが通常は子がいる
                if (winners.length === 0) {
                    winners = topCandidates.filter(e => e.player.id === gmId); // フォールバック
                }
            } else {
                // 子同士の被りは分け（全員勝ち）
                winners = topCandidates;
            }
        } else {
            winners = topCandidates;
        }

        // ヒフミを出したプレイヤーは自分の掛け金2倍の罰金
        evaluated.forEach(e => {
            if (e.isHifumi) {
                const penalty = e.player.bet * 2;
                e.player.chips -= penalty;
                e.netChange = (e.netChange || 0) - penalty;
            }
        });

        // 総取りの精算
        // 勝者（複数なら山分け）が、他の敗者から掛け金×倍率を受け取る
        const winnerCount = winners.length;
        let totalCollected = 0;

        evaluated.forEach(e => {
            const isWinner = winners.some(w => w.player.id === e.player.id);
            if (!isWinner) {
                // 敗者の支払い：自分のベット額 × 勝者の倍率（複数いる場合は代表して最初の勝者の倍率、あるいはそれぞれの倍率）
                const mult = winners[0].multiplier || 1;
                const payAmount = e.player.bet * mult;
                e.player.chips -= payAmount;
                e.netChange = (e.netChange || 0) - payAmount;
                totalCollected += payAmount;
            }
        });

        // 勝者への配分
        const share = Math.floor(totalCollected / winnerCount);
        winners.forEach(w => {
            w.player.chips += share;
            w.player.netChange = (w.player.netChange || 0) + share;
        });

        room.roundSummary = {
            winners: winners.map(w => w.player.name),
            winnerNames: winners.map(w => `${w.player.name} (${w.player.lastResult.name})`).join(', '),
            totalCollected
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
