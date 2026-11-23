# PetDuel Discord Bot

## Çalıştırma (Windows)
1. Klasörü masaüstüne çıkar.
2. `BASLAT.bat`'a çift tıkla. İlk seferde paketleri kurar (1-2 dk), sonra bot açılır.
   Bot kapanırsa 5 saniye sonra kendini yeniden başlatır. Durdurmak için pencereyi kapat.
3. Eski botu (aynı token ile çalışan) **kapat**, ikisi aynı anda açık olmasın.

`.env` dosyasında `DISCORD_TOKEN` (bot token) ve `BOT_KEY` (petduel.win bağlantı anahtarı) var.
Bunları kimseyle paylaşma, GitHub'a yükleme.

## Discord ayarları (bir kere, ZORUNLU)
- Discord Developer Portal → uygulaman → **Bot** → **Privileged Gateway Intents**:
  **Message Content Intent** AÇIK olmalı. Kapalıysa bot `!` komutlarını okuyamaz.
  **Server Members Intent** de açık olsun (giriş/çıkış logları ve rank rolleri için).
- Sunucuda botun rolüne **Administrator** ver ve bot rolünü listede **en üste** (rank rollerinin ve silinecek rollerin üstüne) taşı.

## Komutlar (prefix: `!`)
Eski `/` komutları kaldırıldı, bot açılınca Discord'dan da silinir. Komutlar `!` ile yazılır:

- Herkes: `!help` `!link KOD` `!unlink` `!profile` `!rank` `!leaderboard` `!stats` `!games` `!website` `!coinflip`
- Yetkili: `!withdrawals` `!clear 20` `!timeout @kişi 30 sebep` `!kick @kişi sebep` `!ban @kişi sebep`
- Admin: `!site maintenance on|off` `!site say mesaj` `!site bot DedokAmp on|off` `!site block TR`
  `!player info isim` `!player give isim "Neon Shadow Dragon" qty:3` `!match cancel ID`
  `!event wheel "Shadow Dragon" 60` `!announce "Başlık" mesaj` `!giveaway start "Shadow Dragon" 60 2` `!ticketpanel`

Kurallar:
- Boşluklu yazılar **"tırnak"** içinde ("Shadow Dragon"). Sonraki zorunlu bilgi yoksa son yazı tırnaksız da olur.
- Üye: **@etiket** ya da ID.
- İsteğe bağlı ayarlar **isim:değer** şeklinde yazılabilir: `qty:3`, `winners:2`, `everyone:true`.
- Yanlış yazınca bot doğru kullanımı gösterir. `!giveaway` yazınca tüm alt komutları listeler.
- Yetkiler eskisi gibi: yetkisi olmayan admin komutlarını kullanamaz.
- Prefix'i değiştirmek için `config.json` → `"prefix"`.

## Rol simgeleri
- `role-icons/` klasöründe her rank ve Owner / Admin / Moderator / Staff / Support / Linked için simge var.
- Bot açılınca bu isimdeki rollere simgeyi kendisi takar (simgesi olan rollere dokunmaz;
  hepsini değiştirmek için `config.json` → `"replaceRoleIcons": true`).
- **Discord rol simgelerini sadece Boost Level 2 (7+ boost) sunucularda gösterir.** Değilse bot simgeleri atlar ve
  logda yazar.
- Kendi simgeni koymak için `role-icons/RolAdı.png` dosyasını değiştir (PNG, en fazla 256 KB).

## Silinen roller
- `config.json` → `"deleteRoles"` listesindeki roller (Red Team, Blue Team) bot açılınca silinir.
  Bot rolü bu rollerin üstünde olmalı.

## Kanallar
- Bot **hiç kanal kurmaz**, var olan kanalları kullanır.
- Kanalları `config.json` → `channelIds` içindeki ID ile, ID yoksa isimle bulur (emoji ve süsler önemsiz).
- Ticket butonunu koymak için kanalda `!ticketpanel` yaz.

## Siteyle bağlantı
- Yeni coinflipler ve sonuçları → #coinflips, jackpot → #jackpots, giveaway ve event'ler → #giveaways
- Çekim istekleri → #withdrawals, **Mark sent / Refund** butonlarıyla
- Oyuncular sitede Profile → **Link Discord** ile kod alır, Discord'da `!link KOD` yazar → rank rolü otomatik verilir
  (kodlu mesaj güvenlik için hemen silinir; roller her 10 dakikada bir güncellenir)
