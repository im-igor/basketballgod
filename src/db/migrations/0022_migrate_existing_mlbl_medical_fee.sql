-- В живой базе медицинский сбор был создан для обеих команд: в режиме PLAYED
-- это означало «сыгравшие за BLACK», но в ACTIVE означало бы взнос с RED.
-- Переносим его на BLACK и сохраняем существующий fee_id: история назначений
-- продолжает защищать уже оплативших игроков от повторного начисления.
update extra_fees
set team = 'BLACK', mode = 'ACTIVE', league = 'ANY', end_period = null
where team in ('BLACK', 'BOTH')
  and mode = 'PLAYED'
  and league = 'MLBL'
  and lower(trim(title)) like 'меддопуск млбл%';
